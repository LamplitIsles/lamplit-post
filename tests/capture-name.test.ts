import { test, expect } from "vitest";
import { settingsFixture } from "./fixtures/settings";
import { until } from "./fixtures/state";
import { start } from "../src/runtime";
import { Message, PostEventV1, ToolOutputs } from "../contracts/v1/index";

test("SDK capture snapshots genuine optional names into strict archive/delivery/history without lookups or historical rewrites", async () => {
  const f = await settingsFixture();
  let reopened: Awaited<ReturnType<typeof start>> | undefined;
  let runtime = () => ({
    store: f.app.app.store,
    service: f.app.app.service,
    http: f.app.app.http,
  });
  const rows = () =>
    runtime()
      .store!.db.prepare("SELECT native,body FROM messages ORDER BY seq")
      .all();
  const deliveries = () =>
    runtime()
      .store!.db.prepare("SELECT id,body,state FROM deliveries ORDER BY seq")
      .all();
  const find = (id: string) =>
    Message.parse(
      JSON.parse(rows().find((r) => r.native === id)!.body as string),
    );
  const native = async (id: string, direct = false, name?: string) => {
    f.platform.sendQQ(
      direct ? "C2C_MESSAGE_CREATE" : "GROUP_AT_MESSAGE_CREATE",
      "owned message",
      {
        id,
        ...(direct ? { group_id: undefined, group_openid: undefined } : {}),
        author: {
          id: "qq-owner",
          ...(name === undefined ? {} : { username: name }),
        },
      },
    );
    await until(() => !!rows().find((r) => r.native === id));
  };
  const call = async (account_id: string, conversation_id: string) => {
    const response = await fetch(runtime().http!.url + "/mcp", {
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
        params: {
          name: "read_messages",
          arguments: {
            account_id,
            conversation_name: runtime().service!.conversation(
              runtime()
                .store!.db.prepare(
                  "SELECT * FROM conversations WHERE account=? AND id=?",
                )
                .get(account_id, conversation_id),
            ).name,
          },
        },
      }),
    });
    const result = (await response.json()).result;
    expect(result.isError).not.toBe(true);
    return ToolOutputs.read_messages.parse(result.structuredContent).items;
  };
  const refresh = async () => {
    expect(
      (await f.request("discover", { account_id: "qq-main" })).status,
    ).toBe(200);
  };
  const saved = () => new Map(rows().map((r) => [r.native, r.body]));
  const pinnedDeliveries = () =>
    new Map(deliveries().map((r) => [r.id, r.body]));
  const checkBytes = (
    messages: Map<unknown, unknown>,
    events: Map<unknown, unknown>,
  ) => {
    for (const [id, body] of messages)
      expect(rows().find((r) => r.native === id)!.body).toBe(body);
    for (const [id, body] of events)
      expect(deliveries().find((r) => r.id === id)!.body).toBe(body);
  };
  try {
    await f.login();
    const ready = f.app.status();
    expect(
      ready.ready,
      JSON.stringify({
        state: ready.state,
        phase: ready.phase,
        closed: runtime().service!.closed,
        transport_failed: f.app.app.transportFailed,
        ready_platforms: [...runtime().service!.platforms.values()].filter(
          (p) => p.ready,
        ).length,
        platforms: runtime().service!.platforms.size,
      }),
    ).toBe(true);
    await native("group-before-metadata");
    expect(find("group-before-metadata").conversation.name).toBe("QQ 群聊 1");
    const initial = await f.app.view();
    expect(
      (
        await f.apply("settings", {
          version: initial.version,
          accounts: initial.accounts.map(({ hasCredential, ready, ...a }) => a),
          agents: initial.agents.map(({ hasCredential, hasToken, ...a }) => a),
          bindings: initial.bindings.map((b) => ({
            ...b,
            scopes: b.scopes.map(({ name, ...s }) => s),
          })),
          conversation_names: [
            {
              account_id: "qq-main",
              conversation_id: "qq-group",
              name: "Genuine group",
            },
            {
              account_id: "qq-main",
              conversation_id: "qq-dm",
              name: "Old contact",
            },
          ],
        })
      ).status,
    ).toBe(200);
    await native("direct-old-name", true, "Old contact");
    expect.soft(find("direct-old-name").conversation.name).toBe("Old contact");
    const fresh = 'Fresh "contact"\n' + "x".repeat(300);
    await native("direct-fresh-name", true, "  " + fresh + "  ");
    expect
      .soft(find("direct-fresh-name").conversation.name)
      .toBe("Old contact");
    expect(find("direct-fresh-name").sender.name).toBe("  " + fresh + "  ");
    expect(
      f.platform.calls.filter((c) => c.path.endsWith("/info")),
    ).toHaveLength(0);
    const oldMessages = saved(),
      oldEvents = pinnedDeliveries();
    f.platform.qqGroupName("qq-group", "Genuine group");
    await refresh();
    checkBytes(oldMessages, oldEvents);
    const lookups = f.platform.calls.filter((c) =>
      c.path.endsWith("/info"),
    ).length;
    await native("group-known-metadata");
    expect
      .soft(find("group-known-metadata").conversation.name)
      .toBe("Genuine group");
    expect(
      f.platform.calls.filter((c) => c.path.endsWith("/info")),
    ).toHaveLength(lookups);
    await until(() => deliveries().every((r) => r.state === "accepted"));
    const capturedEvents = f.receiver.attempts.map((body) =>
      PostEventV1.parse(JSON.parse(body)),
    );
    expect
      .soft(
        capturedEvents.find(
          (e) => e.message.native_message_id === "direct-fresh-name",
        )!.message.conversation.name,
      )
      .toBe("Old contact");
    expect
      .soft(
        capturedEvents.find(
          (e) => e.message.native_message_id === "group-known-metadata",
        )!.message.conversation.name,
      )
      .toBe("Genuine group");
    expect(
      capturedEvents.find(
        (e) => e.message.native_message_id === "group-before-metadata",
      )!.message.conversation.name,
    ).toBe("QQ 群聊 1");
    const beforeDuplicate = rows().length,
      beforeDeliveries = deliveries().length;
    await native(
      "direct-old-name",
      true,
      "Duplicate metadata is not a new message",
    );
    // Wait on the existing serialized adapter chain, not a timing sleep.
    await (
      runtime().service!.platforms.get(
        "qq-main",
      ) as import("../src/host").QQPlatform
    ).chain;
    expect(rows()).toHaveLength(beforeDuplicate);
    expect(deliveries()).toHaveLength(beforeDeliveries);
    checkBytes(oldMessages, oldEvents);
    // Later platform metadata, including ID-shaped metadata, cannot replace saved names.
    f.platform.qqGroupName("qq-group", "qq-group");
    await refresh();
    await native("group-id-fallback");
    expect(find("group-id-fallback").conversation.name).toBe("Genuine group");
    await native("direct-id-fallback", true, "qq-owner");
    expect(find("direct-id-fallback").conversation.name).toBe("Old contact");
    f.platform.sendMatrix(
      { body: "Post, no retained display metadata", msgtype: "m.text" },
      { event_id: "$matrix-unknown" },
    );
    await until(() => !!rows().find((r) => r.native === "$matrix-unknown"));
    expect(find("$matrix-unknown").conversation.name).toBe("Matrix 群聊 3");
    // Matrix capture uses already retained genuine metadata, not capture-time discovery.
    const matrix = await (
      await f.request("discover", { account_id: "matrix-main" })
    ).json();
    const room = matrix.items.find((c: any) => c.native_id === "!room:fixture");
    const view = await f.app.view();
    expect(
      (
        await f.apply("settings", {
          version: view.version,
          accounts: view.accounts.map(({ hasCredential, ready, ...a }) => a),
          agents: view.agents.map(({ hasCredential, hasToken, ...a }) => a),
          bindings: view.bindings.map((b) => ({
            ...b,
            scopes: b.scopes.map(({ name, ...s }) => s),
          })),
          conversation_names: [
            {
              account_id: "matrix-main",
              conversation_id: "matrix-room",
              name: room.name,
            },
          ],
        })
      ).status,
    ).toBe(200);
    f.platform.sendMatrix(
      { body: "Post, owned matrix capture", msgtype: "m.text" },
      { event_id: "$matrix-name" },
    );
    await until(() => !!rows().find((r) => r.native === "$matrix-name"));
    expect.soft(find("$matrix-name").conversation.name).toBe(room.name);
    const originalMessages = saved(),
      originalEvents = pinnedDeliveries();
    f.platform.qqGroupName("qq-group", "Renamed after capture");
    await refresh();
    checkBytes(originalMessages, originalEvents);
    const config = f.app.config;
    await f.web.stop();
    await f.app.stop();
    reopened = await start(config, {
      qqOrigin: f.platform.url,
      qqGateway: f.platform.gateway,
    });
    runtime = () => reopened!;
    checkBytes(originalMessages, originalEvents);
    const group = await call("qq-main", "qq-group"),
      direct = await call("qq-main", "qq-dm");
    expect
      .soft(
        group.find((m) => m.native_message_id === "group-known-metadata")!
          .conversation.name,
      )
      .toBe("Genuine group");
    expect(
      group.find((m) => m.native_message_id === "group-before-metadata")!
        .conversation.name,
    ).toBe("QQ 群聊 1");
    expect
      .soft(
        direct.find((m) => m.native_message_id === "direct-old-name")!
          .conversation.name,
      )
      .toBe("Old contact");
    expect
      .soft(
        direct.find((m) => m.native_message_id === "direct-fresh-name")!
          .conversation.name,
      )
      .toBe("Old contact");
    expect
      .soft(
        (await call("matrix-main", "matrix-room")).find(
          (m) => m.native_message_id === "$matrix-name",
        )!.conversation.name,
      )
      .toBe(room.name);
    expect(
      (await call("matrix-main", "matrix-room")).find(
        (m) => m.native_message_id === "$matrix-unknown",
      )!.conversation.name,
    ).toBe("Matrix 群聊 3");
    const sample = find("group-before-metadata");
    expect
      .soft(
        Message.safeParse({
          ...sample,
          conversation: { ...sample.conversation, name: "Genuine name" },
        }).success,
      )
      .toBe(true);
    expect(
      Message.safeParse({
        ...sample,
        conversation: { ...sample.conversation, name: "x".repeat(257) },
      }).success,
    ).toBe(false);
    expect(f.platform.sendCount).toBe(0);
  } finally {
    await reopened?.stop();
    await f.close();
  }
});
