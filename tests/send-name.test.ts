import { test, expect, vi } from "vitest";
import { settingsFixture } from "./fixtures/settings";
import { until } from "./fixtures/state";
import { start } from "../src/runtime";

async function fixture() {
  const f = await settingsFixture();
  let endpoint = () => f.app.app.http!.url;
  const call = async (name: string, args: unknown) => {
    const response = await fetch(endpoint() + "/mcp", {
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
    expect(response.status).toBe(200);
    return (await response.json()).result;
  };
  const send = (
    request_id: string,
    target: Record<string, unknown>,
    text = "owned named send",
  ) =>
    call("send_message", {
      ...target,
      request_id,
      content: [{ type: "text", text }],
    });
  const refresh = async () => {
    const response = await f.request("discover", { account_id: "qq-main" });
    expect(response.status).toBe(200);
    return (await response.json()).items;
  };
  const apply = async (extra: Record<string, unknown> = {}) => {
    const v = await f.app.view();
    expect(
      (
        await f.apply("settings", {
          version: v.version,
          accounts: v.accounts.map(({ hasCredential, ready, ...a }) => a),
          agents: v.agents.map(({ hasCredential, hasToken, ...a }) => a),
          bindings: v.bindings.map((b) => ({
            ...b,
            scopes: b.scopes.map(({ name, ...s }) => s),
          })),
          ...extra,
        })
      ).status,
    ).toBe(200);
  };
  await f.login();
  return {
    f,
    call,
    send,
    refresh,
    apply,
    endpoint: (value: () => string) => {
      endpoint = value;
    },
  };
}

test("public send_message routes exact granted QQ group/contact and Matrix names, rejects ambiguity/hidden names and retains ID fallback", async () => {
  const { f, call, send, refresh, apply } = await fixture();
  try {
    const listed = await (
      await fetch(f.app.app.http!.url + "/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + f.state.token,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      })
    ).json();
    const schema = listed.result.tools.find(
      (t: any) => t.name === "send_message",
    ).inputSchema;
    expect(schema.type).toBe("object");
    expect(schema.properties.conversation_name).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 256,
    });
    expect(schema.required).toEqual(["request_id", "content"]);
    f.platform.qqGroupName("qq-group", "Owned group");
    f.platform.sendQQ("C2C_MESSAGE_CREATE", "owned contact observation", {
      id: "named-contact",
      group_id: undefined,
      group_openid: undefined,
      author: { id: "qq-owner", username: "Owned contact" },
    });
    await until(
      () =>
        !!f.app.store.db
          .prepare("SELECT id FROM messages WHERE native='named-contact'")
          .get(),
    );
    await refresh();
    expect(
      (await send("group-name", { conversation_name: "Owned group" }))
        .structuredContent.status,
    ).toBe("sent");
    expect(
      f.platform.calls.filter((c) => c.path.endsWith("/messages")).at(-1)!.path,
    ).toBe("/v2/groups/qq-group/messages");
    expect(
      (await send("contact-name", { conversation_name: "Owned contact" }))
        .structuredContent.status,
    ).toBe("sent");
    expect(
      f.platform.calls.filter((c) => c.path.endsWith("/messages")).at(-1)!.path,
    ).toBe("/v2/users/qq-owner/messages");
    const matrix = await (
      await f.request("discover", { account_id: "matrix-main" })
    ).json();
    const room = matrix.items.find((c: any) => c.native_id === "!room:fixture");
    await apply({
      conversation_names: [
        {
          account_id: "matrix-main",
          conversation_id: "matrix-room",
          name: room.name,
        },
      ],
    });
    expect(
      (await send("matrix-name", { conversation_name: room.name }))
        .structuredContent.status,
    ).toBe("sent");
    const shared = 'Shared "room"\n<untrusted>';
    f.platform.qqGroupName("qq-group", shared);
    f.platform.sendQQ("C2C_MESSAGE_CREATE", "renamed contact observation", {
      id: "renamed-contact",
      group_id: undefined,
      group_openid: undefined,
      author: { id: "qq-owner", username: shared },
    });
    f.platform.sendQQ("GROUP_MESSAGE_CREATE", "hidden group", {
      id: "hidden-message",
      group_id: "hidden-group",
      group_openid: "hidden-group",
    });
    f.platform.qqGroupName("hidden-group", "Hidden name");
    await until(
      () =>
        !!f.app.store.db
          .prepare("SELECT id FROM messages WHERE native='hidden-message'")
          .get(),
    );
    const known = await refresh();
    const hidden = known.find((c: any) => c.native_id === "hidden-group");
    const own = await f.app.view();
    await apply({
      agents: [
        ...own.agents.map(({ hasCredential, hasToken, ...a }) => a),
        {
          id: "other",
          receiver_url: f.receiver.url,
          receiver_credential: "other-receiver",
        },
      ],
      bindings: [
        ...own.bindings.map((b) => ({
          ...b,
          scopes: b.scopes.map(({ name, ...s }) => s),
        })),
        {
          id: "other-only",
          agent_id: "other",
          account_ids: [],
          scopes: [],
          wake: { direct: false, mention: false, reply: false, aliases: [] },
        },
      ],
      secrets: [
        {
          ref: "other-receiver",
          account: "other",
          kind: "receiver",
          value: "owned-other-secret",
        },
      ],
    });
    await f.app.store.issue("other");
    await apply({
      conversation_names: [
        {
          account_id: "matrix-main",
          conversation_id: "matrix-room",
          name: shared,
        },
      ],
    });
    const before = f.platform.sendCount;
    for (const name of ["Missing name", "shared", "Hidden name"])
      expect(
        (await send("missing-" + name, { conversation_name: name }))
          .structuredContent.error.code,
      ).toBe("not_found");
    const ambiguous = await send("ambiguous", { conversation_name: shared });
    expect(ambiguous.structuredContent.error.code).toBe("conflict");
    expect(ambiguous.structuredContent.error.message).toContain(
      JSON.stringify(shared),
    );
    expect(ambiguous.structuredContent.error.message).not.toContain(
      "Hidden name",
    );
    expect(ambiguous.structuredContent.error.message.length).toBeLessThan(8192);
    expect(f.platform.sendCount).toBe(before);
    for (const [id, filters] of [
      ["group-filter", { platform: "qq", conversation_type: "group" }],
      ["direct-filter", { conversation_type: "direct" }],
      ["matrix-filter", { account_id: "matrix-main" }],
    ] as const)
      expect(
        (await send(id, { conversation_name: shared, ...filters }))
          .structuredContent.status,
      ).toBe("sent");
    // Same-account, same-type collisions still require exact IDs, never recency.
    const extra = known.find((c: any) => c.native_id === "hidden-group");
    const v = await f.app.view();
    await apply({
      bindings: v.bindings.map((b) => ({
        ...b,
        scopes:
          b.agent_id !== "cfl"
            ? b.scopes.map(({ name, ...s }) => s)
            : [
                ...b.scopes.map(({ name, ...s }) => s),
                {
                  account_id: "qq-main",
                  conversation_id: extra.conversation_id,
                  native_id: extra.native_id,
                  type: "group",
                  senders: [],
                },
              ],
      })),
    });
    f.platform.qqGroupName("hidden-group", shared);
    await refresh();
    const collisionCount = f.platform.sendCount;
    expect(
      (
        await send("same-account-conflict", {
          conversation_name: shared,
          account_id: "qq-main",
          conversation_type: "group",
        })
      ).structuredContent.error.code,
    ).toBe("conflict");
    expect(f.platform.sendCount).toBe(collisionCount);
    expect(
      (
        await send("id-fallback", {
          account_id: "qq-main",
          conversation_id: "qq-group",
        })
      ).structuredContent.status,
    ).toBe("sent");
    for (const target of [
      {},
      { conversation_id: "qq-group" },
      { conversation_name: shared, conversation_id: "qq-group" },
      { account_id: "qq-main", conversation_id: "qq-group", platform: "qq" },
    ])
      expect(
        (await send("invalid-selector", target)).structuredContent.error.code,
      ).toBe("invalid_request");
    const denied = await f.app.view();
    await apply({
      bindings: denied.bindings.map((b) => ({
        ...b,
        scopes: b.scopes.map(({ name, ...s }) =>
          s.type === "direct" ? { ...s, senders: [] } : s,
        ),
      })),
    });
    expect(
      (
        await send("empty-peer", {
          conversation_name: shared,
          conversation_type: "direct",
        })
      ).structuredContent.error.code,
    ).toBe("not_found");
    expect(
      (
        await call("get_conversation", {
          account_id: "qq-main",
          conversation_id: "qq-dm",
        })
      ).structuredContent.error.code,
    ).toBe("not_found");
  } finally {
    await f.close();
  }
});

test("name request pins survive rename, collision, restart, unknown reservation and revocation without rerouting or resending", async () => {
  const x = await fixture(),
    { f, send, refresh, apply } = x;
  let reopened: Awaited<ReturnType<typeof start>> | undefined;
  try {
    f.platform.qqGroupName("qq-group", "Original name");
    await refresh();
    const target = { conversation_name: "Original name" };
    const first = await send("pinned-name", target);
    expect(first.structuredContent.status).toBe("sent");
    f.platform.failAt(f.platform.sendCount + 1, 500);
    const unknown = await send("unknown-name", target);
    expect(unknown.structuredContent.status).toBe("unknown");
    f.platform.qqGroupName("qq-group", "Renamed group");
    f.platform.sendQQ("C2C_MESSAGE_CREATE", "old name now a different target", {
      id: "name-reassigned",
      group_id: undefined,
      group_openid: undefined,
      author: { id: "qq-owner", username: "Original name" },
    });
    await until(
      () =>
        !!f.app.store.db
          .prepare("SELECT id FROM messages WHERE native='name-reassigned'")
          .get(),
    );
    await refresh();
    const count = f.platform.sendCount,
      calls = f.platform.calls.length;
    expect(
      await x.call("send_message", {
        content: [{ type: "text", text: "owned named send" }],
        request_id: "pinned-name",
        conversation_name: "Original name",
      }),
    ).toEqual(first);
    expect(await send("unknown-name", target)).toEqual(unknown);
    expect(f.platform.sendCount).toBe(count);
    expect(
      f.platform.calls.slice(calls).every((c) => c.path.endsWith("/sync")),
    ).toBe(true);
    expect(
      (await send("pinned-name", { conversation_name: "Renamed group" }))
        .structuredContent.error.code,
    ).toBe("conflict");
    expect(
      (await send("pinned-name", target, "changed content")).structuredContent
        .error.code,
    ).toBe("conflict");
    // An admitted native reservation with no durable result reopens as unknown.
    f.app.store.db
      .prepare("UPDATE sends SET result=NULL WHERE request='unknown-name'")
      .run();
    const config = f.app.config;
    await f.web.stop();
    await f.app.stop();
    reopened = await start(config, {
      qqOrigin: f.platform.url,
      qqGateway: f.platform.gateway,
    });
    x.endpoint(() => reopened!.http.url);
    const afterStart = f.platform.sendCount,
      startCalls = f.platform.calls.length;
    expect(await send("pinned-name", target)).toEqual(first);
    expect(
      (await send("unknown-name", target)).structuredContent,
    ).toMatchObject({ status: "unknown", parts: [], stored: false });
    expect(f.platform.sendCount).toBe(afterStart);
    expect(
      f.platform.calls.slice(startCalls).every((c) => c.path.endsWith("/sync")),
    ).toBe(true);
    // Current local authority is still checked against the PIN, not the old name's new owner.
    reopened.service.config.bindings[0]!.scopes =
      reopened.service.config.bindings[0]!.scopes.filter(
        (s) => s.conversation_id !== "qq-group",
      );
    expect(
      (await send("pinned-name", target)).structuredContent.error.code,
    ).toBe("not_found");
    expect(f.platform.sendCount).toBe(afterStart);
  } finally {
    await reopened?.stop();
    await f.close();
  }
});

test("pre-upgrade ID fingerprints still reconcile and concurrent exact name requests have one native send", async () => {
  const { f, send, refresh } = await fixture();
  try {
    const oldInput =
      '{"account_id":"qq-main","conversation_id":"qq-group","request_id":"old-id","content":[{"type":"text","text":"original"}],"reply_to_message_id":"historical-post-message"}';
    const oldResult = {
      request_id: "old-id",
      status: "sent",
      parts: [
        {
          index: 0,
          status: "sent",
          native_message_ids: ["already-confirmed"],
          stored: true,
        },
      ],
      stored: true,
    };
    f.app.store.db
      .prepare("INSERT INTO sends(agent,request,input,result) VALUES(?,?,?,?)")
      .run("cfl", "old-id", oldInput, JSON.stringify(oldResult));
    const before = f.platform.calls.length;
    expect(
      (
        await send(
          "old-id",
          {
            conversation_id: "qq-group",
            account_id: "qq-main",
            reply_to_message_id: "historical-post-message",
          },
          "original",
        )
      ).structuredContent,
    ).toEqual(oldResult);
    expect(
      f.platform.calls.slice(before).every((c) => c.path.endsWith("/sync")),
    ).toBe(true);
    f.platform.qqGroupName("qq-group", "Concurrent group");
    await refresh();
    f.platform.holdNextSend(100);
    const startCount = f.platform.sendCount;
    const results = await Promise.all([
      send("concurrent-name", { conversation_name: "Concurrent group" }),
      send("concurrent-name", { conversation_name: "Concurrent group" }),
    ]);
    expect(results.some((r) => r.structuredContent.status === "sent")).toBe(
      true,
    );
    expect(
      results.every((r) =>
        ["sent", "unknown"].includes(r.structuredContent.status),
      ),
    ).toBe(true);
    expect(f.platform.sendCount).toBe(startCount + 1);
    expect(
      (await send("concurrent-name", { conversation_name: "Concurrent group" }))
        .structuredContent.status,
    ).toBe("sent");
    expect(f.platform.sendCount).toBe(startCount + 1);
  } finally {
    await f.close();
  }
});

test("a name changed during preflight cannot silently retarget before native admission", async () => {
  const { f, call, refresh } = await fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  let bytes: ReturnType<typeof vi.spyOn> | undefined;
  try {
    f.platform.qqGroupName("qq-group", "Before preflight");
    await refresh();
    const upload = await fetch(f.app.app.http!.url + "/assets", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + f.state.token,
        "Content-Type": "application/octet-stream",
      },
      body: f.platform.media,
    });
    expect(upload.status).toBe(201);
    const asset = await upload.json();
    const assets = f.app.app.service!.assets,
      original = assets.bytes.bind(assets);
    bytes = vi
      .spyOn(assets, "bytes")
      .mockImplementationOnce(async (...args) => {
        entered = true;
        await held;
        return original(...args);
      });
    const pending = call("send_message", {
      conversation_name: "Before preflight",
      request_id: "changing-name",
      content: [{ type: "file", asset_id: asset.asset_id }],
    });
    try {
      await until(() => entered);
      f.platform.qqGroupName("qq-group", "After preflight");
      await refresh();
    } finally {
      release();
    }
    expect((await pending).structuredContent.error.code).toBe("conflict");
    expect(
      f.app.store.db
        .prepare("SELECT request FROM sends WHERE request='changing-name'")
        .get(),
    ).toBeUndefined();
    expect(f.platform.sendCount).toBe(0);
  } finally {
    release();
    bytes?.mockRestore();
    await f.close();
  }
});
