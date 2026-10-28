import { test, expect } from "vitest";
import { settingsFixture } from "./fixtures/settings";
import { until } from "./fixtures/state";

test("first QQ group observation stores a known name or a bounded fallback and never replaces a concurrent name", async () => {
  const f = await settingsFixture();
  const capture = (id: string, native: string) =>
    f.platform.sendQQ("GROUP_AT_MESSAGE_CREATE", "owned group message", {
      id,
      group_id: native,
      group_openid: native,
    });
  const row = (native: string) =>
    f.app.store.db
      .prepare("SELECT * FROM conversations WHERE account=? AND native=?")
      .get("qq-main", native);
  try {
    f.platform.qqGroupName("known-owned", "Known group");
    capture("known-event", "known-owned");
    await until(() => !!row("known-owned"));
    expect(row("known-owned")!.name).toBe("Known group");
    f.platform.qqGroupName("missing-owned", null);
    capture("missing-event", "missing-owned");
    await until(() => !!row("missing-owned"));
    expect(row("missing-owned")!.name).toMatch(/^QQ 群聊 \d+$/);
    f.platform.delayQQMetadata(5000);
    const started = performance.now();
    capture("timeout-event", "timeout-owned");
    await until(() => !!row("timeout-owned"), 3000);
    expect(performance.now() - started).toBeLessThan(2500);
    expect(row("timeout-owned")!.name).toMatch(/^QQ 群聊 \d+$/);
    await until(() => f.platform.aborts >= 1);
    f.platform.delayQQMetadata(400);
    f.platform.qqGroupName("race-owned", "Competing platform name");
    capture("race-event", "race-owned");
    await until(() =>
      f.platform.calls.some(
        (c) => c.path.includes("race-owned") && c.path.endsWith("/info"),
      ),
    );
    f.app.store.db
      .prepare(
        "INSERT INTO conversations(id,account,native,type,name) VALUES (?,?,?,?,?)",
      )
      .run("race-id", "qq-main", "race-owned", "group", "Administrator name");
    await until(
      () =>
        !!f.app.store.db
          .prepare("SELECT id FROM messages WHERE native=?")
          .get("race-event"),
      3000,
    );
    expect(row("race-owned")!.name).toBe("Administrator name");
    f.platform.delayQQMetadata(0);
    f.platform.qqGroupName("race-owned", "Later platform name");
    capture("race-next", "race-owned");
    await until(
      () =>
        !!f.app.store.db
          .prepare("SELECT id FROM messages WHERE native=?")
          .get("race-next"),
    );
    expect(row("race-owned")!.name).toBe("Administrator name");
  } finally {
    await f.close();
  }
});

test("QQ discovery preserves the stored group name when upstream metadata changes", async () => {
  const f = await settingsFixture();
  try {
    await f.login();
    const before = await f.app.view();
    const group = before.bindings[0]!.scopes.find(
      (s) => s.conversation_id === "qq-group",
    )!;
    expect(group.name).toMatch(/^QQ 群聊 \d+$/);
    f.platform.qqGroupName("qq-group", "Later upstream name");
    const response = await f.request("discover", { account_id: "qq-main" });
    expect(response.status).toBe(200);
    expect(
      (await response.json()).items.find(
        (item: any) => item.conversation_id === "qq-group",
      ).name,
    ).toBe(group.name);
    expect(
      f.app.store.db
        .prepare("SELECT name FROM conversations WHERE id=?")
        .get("qq-group")!.name,
    ).toBe(group.name);
    const saved = await f.apply("settings", {
      version: before.version,
      accounts: before.accounts.map(({ hasCredential, ready, ...a }) => a),
      agents: before.agents.map(({ hasCredential, hasToken, ...a }) => a),
      bindings: before.bindings.map((b) => ({
        ...b,
        scopes: b.scopes.map(({ name, ...s }) => s),
      })),
      conversation_names: [
        {
          account_id: "qq-main",
          conversation_id: "qq-group",
          name: "Administrator group",
        },
      ],
    });
    expect(saved.status).toBe(200);
    f.platform.qqGroupName("qq-group", "Another platform name");
    const after = await (
      await f.request("discover", { account_id: "qq-main" })
    ).json();
    expect(
      after.items.find((item: any) => item.conversation_id === "qq-group").name,
    ).toBe("Administrator group");
    expect(f.receiver.attempts).toEqual([]);
  } finally {
    await f.close();
  }
});

test("shutdown cancels and drains an in-flight first-group lookup", async () => {
  const f = await settingsFixture();
  try {
    f.platform.delayQQMetadata(5000);
    f.platform.sendQQ("GROUP_AT_MESSAGE_CREATE", "owned shutdown", {
      id: "shutdown-event",
      group_id: "shutdown-owned",
      group_openid: "shutdown-owned",
    });
    await until(() =>
      f.platform.calls.some(
        (c) => c.path.includes("shutdown-owned") && c.path.endsWith("/info"),
      ),
    );
    const started = performance.now();
    await f.app.stop();
    expect(performance.now() - started).toBeLessThan(1500);
    await until(() => f.platform.aborts >= 1);
    expect(f.app.store.owner.closed).toBe(true);
  } finally {
    await f.close();
  }
});

test("queued inbound work cancels optional metadata without blocking the queue or later lookups", async () => {
  const f = await settingsFixture();
  try {
    f.platform.delayQQMetadata(5000);
    f.platform.sendQQ("GROUP_AT_MESSAGE_CREATE", "owned first", {
      id: "pressure-first",
      group_id: "pressure-owned",
      group_openid: "pressure-owned",
    });
    await until(() =>
      f.platform.calls.some(
        (c) => c.path.includes("pressure-owned") && c.path.endsWith("/info"),
      ),
    );
    const start = performance.now();
    f.platform.sendQQ("C2C_MESSAGE_CREATE", "owned second", {
      id: "pressure-second",
      group_id: undefined,
      group_openid: undefined,
      author: { id: "qq-owner" },
    });
    await until(
      () =>
        !!f.app.store.db
          .prepare("SELECT id FROM messages WHERE native=?")
          .get("pressure-second"),
      2000,
    );
    const elapsed = performance.now() - start;
    console.log(
      JSON.stringify({
        metric: "queued_group_lookup_ms",
        elapsed_ms: Math.round(elapsed),
      }),
    );
    expect(elapsed).toBeLessThan(700);
    await until(() => f.platform.aborts >= 1);
    const messages = f.app.store.db
      .prepare("SELECT native FROM messages WHERE native IN (?,?) ORDER BY seq")
      .all("pressure-first", "pressure-second");
    expect(messages.map((m) => m.native)).toEqual([
      "pressure-first",
      "pressure-second",
    ]);
    expect(
      f.app.store.db
        .prepare("SELECT name FROM conversations WHERE native=?")
        .get("pressure-owned")!.name,
    ).toMatch(/^QQ 群聊 \d+$/);
    const qq = f.app.app.service!.platforms.get(
      "qq-main",
    ) as import("../src/host").QQPlatform;
    await qq.chain;
    expect(qq.pending).toBe(0);
    expect(f.app.app.service!.errors.has("qq-main")).toBe(false);
    f.platform.delayQQMetadata(0);
    f.platform.qqGroupName("after-pressure", "Later group");
    f.platform.sendQQ("GROUP_AT_MESSAGE_CREATE", "owned third", {
      id: "pressure-third",
      group_id: "after-pressure",
      group_openid: "after-pressure",
    });
    await until(
      () =>
        !!f.app.store.db
          .prepare("SELECT id FROM messages WHERE native=?")
          .get("pressure-third"),
    );
    expect(
      f.app.store.db
        .prepare("SELECT name FROM conversations WHERE native=?")
        .get("after-pressure")!.name,
    ).toBe("Later group");
    await qq.chain;
    expect(qq.pending).toBe(0);
  } finally {
    await f.close();
  }
});
