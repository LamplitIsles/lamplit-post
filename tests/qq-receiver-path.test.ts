import { test, expect, vi } from "vitest";
import { settingsFixture } from "./fixtures/settings";
import { httpFixture } from "./fixtures/http";
import { until } from "./fixtures/state";
import { PostEventV1 } from "../contracts/v1/index";

test("real QQ group mention and private SDK observations honor grants and reach only the authenticated receiver; rejection stays pending", async () => {
  const lines: string[] = [];
  const warn = vi
    .spyOn(console, "warn")
    .mockImplementation((line) => lines.push(String(line)));
  const f = await settingsFixture();
  const rejected: { authenticated: boolean; status: number; event: unknown }[] =
    [];
  const bad = await httpFixture(async (req) => {
    rejected.push({
      authenticated:
        req.headers.get("authorization") === "Bearer test-receiver",
      status: 422,
      event: PostEventV1.parse(await req.json()),
    });
    return new Response(null, { status: 422 });
  });
  const update = async (deniedPeer: boolean, badReceiver = false) => {
    const v = await f.app.view();
    const result = await f.apply("settings", {
      version: v.version,
      accounts: v.accounts.map(({ hasCredential, ready, ...a }) => a),
      agents: v.agents.map(({ hasCredential, hasToken, ...a }) => ({
        ...a,
        ...(badReceiver
          ? { receiver_url: `http://127.0.0.1:${bad.port}` }
          : {}),
      })),
      bindings: v.bindings.map((b) => ({
        ...b,
        scopes: b.scopes.map(({ name, ...s }) =>
          s.account_id === "qq-main" && s.type === "direct"
            ? { ...s, senders: deniedPeer ? [] : ["qq-owner"] }
            : s,
        ),
      })),
    });
    expect(result.status).toBe(200);
  };
  const group = (
    id: string,
    type = "GROUP_AT_MESSAGE_CREATE",
    native = "qq-group",
  ) =>
    f.platform.sendQQ(type, "SECRET_DIAGNOSTIC_SENTINEL", {
      id,
      group_id: native,
      group_openid: native,
    });
  const direct = (id: string) =>
    f.platform.sendQQ("C2C_MESSAGE_CREATE", "SECRET_DIAGNOSTIC_SENTINEL", {
      id,
      group_id: undefined,
      group_openid: undefined,
      author: { id: "qq-owner" },
    });
  const captured = () =>
    f.app.store.db
      .prepare("SELECT count(*) n FROM messages WHERE account='qq-main'")
      .get()!.n;
  const ledger = () =>
    f.app.store.db
      .prepare(
        "SELECT state,category,attempt,body FROM deliveries ORDER BY seq",
      )
      .all();
  try {
    await f.login();
    await update(true);
    group("ungranted", "GROUP_AT_MESSAGE_CREATE", "ungranted-group");
    group("ordinary", "GROUP_MESSAGE_CREATE");
    direct("private-default-deny");
    await until(() => captured() === 3);
    expect(ledger()).toEqual([]);
    expect(f.receiver.attempts).toEqual([]);
    await update(false);
    group("group-allowed");
    direct("private-allowed");
    await until(
      () =>
        ledger().length === 2 && ledger().every((r) => r.state === "accepted"),
    );
    expect(f.receiver.attempts).toHaveLength(2);
    const accepted = f.receiver.attempts.map((b) =>
      PostEventV1.parse(JSON.parse(b)),
    );
    expect(accepted.map((e) => e.wake.reason).sort()).toEqual([
      "direct_message",
      "mentioned",
    ]);
    expect(accepted.map((e) => e.message.conversation.type).sort()).toEqual([
      "direct",
      "group",
    ]);
    await update(false, true);
    group("group-rejected");
    direct("private-rejected");
    await until(
      () =>
        ledger().filter(
          (r) =>
            r.state === "pending" &&
            r.category === "receiver_unavailable" &&
            Number(r.attempt) >= 1,
        ).length === 1 &&
        ledger().filter((r) => r.state === "pending").length === 2,
    );
    expect(rejected.every((r) => r.authenticated && r.status === 422)).toBe(
      true,
    );
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    expect(ledger().filter((r) => r.state === "pending")[1]!.attempt).toBe(0);
    expect(ledger().filter((r) => r.state === "accepted")).toHaveLength(2);
    const status = await f.app.app.service!.status();
    expect(status.backlog).toContainEqual({ state: "pending", count: 2 });
    expect(f.platform.sendCount).toBe(0);
    const records = lines
      .map((line) => JSON.parse(line))
      .filter((r) => r.event === "qq_inbound");
    for (const type of ["group", "direct"])
      expect(records).toContainEqual(
        expect.objectContaining({
          stage: "sdk_capture",
          type,
          native_event:
            type === "group" ? "GROUP_AT_MESSAGE_CREATE" : "C2C_MESSAGE_CREATE",
          category: "queued",
        }),
      );
    expect(records).toContainEqual(
      expect.objectContaining({
        stage: "observation",
        type: "direct",
        category: "archived",
        peer_denied: 1,
        deliveries_created: 0,
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        stage: "observation",
        type: "group",
        scope_missing: 1,
        deliveries_created: 0,
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        stage: "observation",
        type: "group",
        admitted: 1,
        wake_none: 1,
        deliveries_created: 0,
      }),
    );
    for (const type of ["group", "direct"]) {
      expect(records).toContainEqual(
        expect.objectContaining({
          stage: "observation",
          type,
          admitted: 1,
          deliveries_created: 1,
        }),
      );
      expect(records).toContainEqual(
        expect.objectContaining({
          stage: "receiver",
          type,
          category: "accepted",
          http_status: 204,
        }),
      );
    }
    expect(records).toContainEqual(
      expect.objectContaining({
        stage: "receiver",
        category: "http_rejected",
        http_status: 422,
      }),
    );
    const allowedKeys = new Set([
      "event",
      "stage",
      "type",
      "category",
      "native_event",
      "bindings",
      "inactive",
      "disabled",
      "scope_missing",
      "peer_denied",
      "admitted",
      "wake_none",
      "wake_direct",
      "wake_mention",
      "wake_reply",
      "wake_alias",
      "deliveries_created",
      "http_status",
      "attempt",
      "elapsed_ms",
    ]);
    for (const record of records)
      expect(Object.keys(record).every((key) => allowedKeys.has(key))).toBe(
        true,
      );
    expect(lines.join("\n")).not.toMatch(
      /SECRET_DIAGNOSTIC_SENTINEL|qq-owner|qq-group|qq-main|test-receiver|Bearer|https?:/,
    );
    await f.app.app.service!.stop();
    const afterStop = lines.length;
    const platform = f.app.app.service!.platforms.get(
      "qq-main",
    ) as import("../src/host").QQPlatform;
    platform.enqueue({
      isDirect: true,
      messageId: "SECRET_DIAGNOSTIC_SENTINEL",
      qq: { t: "SECRET_UNTRUSTED_EVENT" },
    });
    expect(lines.length).toBe(afterStop + 1);
    expect(JSON.parse(lines.at(-1)!)).toEqual({
      event: "qq_inbound",
      stage: "sdk_capture",
      type: "direct",
      native_event: "other",
      category: "stopped",
    });
    expect(lines.join("\n")).not.toContain("SECRET_UNTRUSTED_EVENT");
    expect(f.platform.sendCount).toBe(0);
  } finally {
    await f.close();
    await bad.stop();
    warn.mockRestore();
  }
});

test("existing health reads emit only changed safe readiness counts, distinguishing disconnected QQ and capture/dispatch errors", async () => {
  const lines: string[] = [];
  const warn = vi
    .spyOn(console, "warn")
    .mockImplementation((line) => lines.push(String(line)));
  const f = await settingsFixture();
  try {
    const service = f.app.app.service!;
    const records = () =>
      lines
        .map((line) => JSON.parse(line))
        .filter((r) => r.event === "post_readiness");
    const health = () => fetch(f.app.app.http!.url + "/healthz");
    expect((await health()).status).toBe(200);
    expect(records().at(-1)).toMatchObject({
      category: "healthy",
      qq_total: 1,
      qq_ready: 1,
      matrix_total: 1,
      matrix_ready: 1,
      pending: 0,
      held: 0,
      capture_errors: 0,
      dispatch_errors: 0,
      other_errors: 0,
    });
    const canaryBefore = records().length;
    await service.status(true);
    expect(records()).toHaveLength(canaryBefore + 1);
    const before = records().length;
    await health();
    expect(records()).toHaveLength(before);
    const ready = vi
      .spyOn(service.platforms.get("qq-main")!, "ready", "get")
      .mockReturnValue(false);
    expect((await health()).status).toBe(503);
    expect(records().at(-1)).toMatchObject({
      category: "degraded",
      qq_ready: 0,
      matrix_ready: 1,
      capture_errors: 0,
      dispatch_errors: 0,
    });
    ready.mockRestore();
    service.errors.set("SECRET_READINESS_SENTINEL", "capture_stopped");
    expect((await health()).status).toBe(503);
    expect(records().at(-1)).toMatchObject({
      category: "degraded",
      qq_ready: 1,
      capture_errors: 1,
      dispatch_errors: 0,
    });
    service.errors.set("SECRET_READINESS_SENTINEL", "dispatch_storage");
    await health();
    expect(records().at(-1)).toMatchObject({
      capture_errors: 0,
      dispatch_errors: 1,
    });
    service.errors.set(
      "SECRET_READINESS_SENTINEL",
      "SECRET_UNTRUSTED_ERROR_STRING",
    );
    await health();
    expect(records().at(-1)).toMatchObject({
      other_errors: 1,
      dispatch_errors: 0,
    });
    service.errors.clear();
    await health();
    expect(records().at(-1)).toMatchObject({
      category: "healthy",
      other_errors: 0,
    });
    expect(lines.join("\n")).not.toMatch(
      /SECRET_|qq-main|matrix-main|qq-owner|Bearer|https?:/,
    );
    for (const record of records())
      for (const [key, value] of Object.entries(record))
        if (key !== "event" && key !== "category")
          expect(Number.isSafeInteger(value)).toBe(true);
  } finally {
    await f.close();
    warn.mockRestore();
  }
});
