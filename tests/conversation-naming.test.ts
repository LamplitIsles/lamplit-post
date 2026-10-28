import { test, expect } from "vitest";
import { settingsFixture } from "./fixtures/settings";
import { until } from "./fixtures/state";
import { Store } from "../src/store";
import { Settings } from "../src/settings";

test("unnamed QQ contacts have distinct stable labels and administrator names survive later observations", async () => {
  const f = await settingsFixture(
    false,
    1500,
    undefined,
    undefined,
    undefined,
    (config) => ({
      ...config,
      bindings: config.bindings.map((binding) => ({
        ...binding,
        scopes: [
          ...binding.scopes,
          {
            account_id: "qq-main",
            conversation_id: "second-qq-dm",
            native_id: "second-qq-peer",
            type: "direct",
            senders: ["second-qq-peer"],
          },
        ],
      })),
    }),
  );
  const capture = async (id: string, peer: string, username?: string) => {
    f.platform.sendQQ("C2C_MESSAGE_CREATE", "owned message", {
      id,
      group_id: undefined,
      group_openid: undefined,
      author: { id: peer, ...(username ? { username } : {}) },
    });
    await until(
      () =>
        !!f.app.store.db
          .prepare("SELECT id FROM messages WHERE native=?")
          .get(id),
    );
  };
  try {
    await f.login();
    await capture("first-unnamed", "qq-owner");
    await capture("second-unnamed", "second-qq-peer");
    const rows = f.app.store.db
      .prepare(
        "SELECT * FROM conversations WHERE account=? AND type='direct' ORDER BY seq",
      )
      .all("qq-main") as any[];
    const labels = rows.map((row) => f.app.app.service!.conversation(row).name);
    expect(labels).toHaveLength(2);
    expect(labels[0]).toMatch(/^QQ 私聊 \d+$/);
    expect(labels[1]).toMatch(/^QQ 私聊 \d+$/);
    expect(labels[0]).not.toBe(labels[1]);
    f.app.store.db
      .prepare("UPDATE conversations SET name=NULL WHERE id=?")
      .run("second-qq-dm");
    await capture(
      "legacy-empty-observation",
      "second-qq-peer",
      "Later upstream nickname",
    );
    expect(
      f.app.store.db
        .prepare("SELECT name FROM conversations WHERE id=?")
        .get("second-qq-dm")!.name,
    ).toBe(labels[1]);
    // Existing state may already contain an ID-shaped name of unknown origin.
    f.app.store.db
      .prepare("UPDATE conversations SET name=? WHERE id=?")
      .run("second-qq-peer", "second-qq-dm");
    const tool = async (name: string, args: unknown) => {
      const response = await fetch(f.app.app.http!.url + "/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + f.state.token,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      return (await response.json()).result.structuredContent;
    };
    const legacy = await tool("get_conversation", {
      account_id: "qq-main",
      conversation_name: "second-qq-peer",
    });
    expect(legacy.name).toBe("second-qq-peer");
    expect(
      f.app.store.db
        .prepare("SELECT name FROM conversations WHERE id=?")
        .get("second-qq-dm")!.name,
    ).toBe("second-qq-peer");
    // A supported old empty row gets its deterministic name stored on encounter.
    f.app.store.db
      .prepare("UPDATE conversations SET name=NULL WHERE id=?")
      .run("qq-dm");
    expect(
      (
        await tool("get_conversation", {
          account_id: "qq-main",
          conversation_name: labels[0],
        })
      ).name,
    ).toBe(labels[0]);
    expect(
      f.app.store.db
        .prepare("SELECT name FROM conversations WHERE id=?")
        .get("qq-dm")!.name,
    ).toBe(labels[0]);
    const old = f.app.store.db
      .prepare("SELECT body FROM messages WHERE native=?")
      .get("first-unnamed")!.body;
    const view = await f.app.view();
    expect(
      view.bindings[0]!.scopes.find((s) => s.conversation_id === "qq-dm")!.name,
    ).toBe(labels[0]);
    const response = await f.apply("settings", {
      version: view.version,
      accounts: view.accounts.map(({ hasCredential, ready, ...a }) => a),
      agents: view.agents.map(({ hasCredential, hasToken, ...a }) => a),
      bindings: view.bindings.map((b) => ({
        ...b,
        scopes: b.scopes.map(({ name, ...s }) => s),
      })),
      conversation_names: [
        {
          account_id: "qq-main",
          conversation_id: "qq-dm",
          name: "Owned contact",
        },
      ],
    });
    expect(response.status).toBe(200);
    for (const chosen of ["qq-owner", "qq-dm", "Owned contact"]) {
      const current = await f.app.view();
      const accepted = await f.apply("settings", {
        version: current.version,
        accounts: current.accounts.map(({ hasCredential, ready, ...a }) => a),
        agents: current.agents.map(({ hasCredential, hasToken, ...a }) => a),
        bindings: current.bindings.map((b) => ({
          ...b,
          scopes: b.scopes.map(({ name, ...s }) => s),
        })),
        conversation_names: [
          { account_id: "qq-main", conversation_id: "qq-dm", name: chosen },
        ],
      });
      expect(accepted.status).toBe(200);
      expect(
        f.app.store.db
          .prepare("SELECT name FROM conversations WHERE id=?")
          .get("qq-dm")!.name,
      ).toBe(chosen);
      expect(
        (await f.app.view()).bindings[0]!.scopes.find(
          (s) => s.conversation_id === "qq-dm",
        )!.name,
      ).toBe(chosen);
      expect(
        (
          await tool("get_conversation", {
            account_id: "qq-main",
            conversation_name: chosen,
          })
        ).name,
      ).toBe(chosen);
      await capture(`later-${chosen}`, "qq-owner", "Later platform nickname");
      expect(
        (await f.app.view()).bindings[0]!.scopes.find(
          (s) => s.conversation_id === "qq-dm",
        )!.name,
      ).toBe(chosen);
    }
    await capture(
      "later-native-name",
      "qq-owner",
      "Different upstream nickname",
    );
    const updated = f.app.store.db
      .prepare("SELECT * FROM conversations WHERE account=? AND id=?")
      .get("qq-main", "qq-dm") as any;
    expect(f.app.app.service!.conversation(updated).name).toBe("Owned contact");
    expect(
      f.app.store.db
        .prepare("SELECT body FROM messages WHERE native=?")
        .get("first-unnamed")!.body,
    ).toBe(old);
    expect(JSON.parse(old as string).conversation.name).toBe(labels[0]);
    expect(
      (await f.app.view()).bindings[0]!.scopes.find(
        (s) => s.conversation_id === "qq-dm",
      )!.name,
    ).toBe("Owned contact");
    await f.app.stop();
    const reopened = await Store.open(f.app.config);
    try {
      expect(
        reopened.db
          .prepare("SELECT name FROM conversations WHERE id=?")
          .get("qq-dm")!.name,
      ).toBe("Owned contact");
      expect(
        reopened.db
          .prepare("SELECT name FROM conversations WHERE id=?")
          .get("second-qq-dm")!.name,
      ).toBe("second-qq-peer");
      reopened.db
        .prepare("UPDATE conversations SET name=NULL WHERE id=?")
        .run("qq-dm");
    } finally {
      await reopened.close();
    }
    const restarted = new Settings(f.path, f.app.config, {
      qqOrigin: f.platform.url,
      qqGateway: f.platform.gateway,
    });
    try {
      await restarted.start();
      expect(
        restarted.store.db
          .prepare("SELECT name FROM conversations WHERE id=?")
          .get("qq-dm")!.name,
      ).toBe(labels[0]);
      expect(
        restarted.store.db
          .prepare("SELECT name FROM conversations WHERE id=?")
          .get("second-qq-dm")!.name,
      ).toBe("second-qq-peer");
    } finally {
      await restarted.stop();
    }
  } finally {
    await f.close();
  }
});
