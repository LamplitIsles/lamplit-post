import { test, expect } from "vitest";
import { settingsFixture } from "./fixtures/settings";

const proposal = (v: any) => ({
  version: v.version,
  accounts: v.accounts.map(({ hasCredential, ready, ...a }: any) => a),
  agents: v.agents.map(({ hasCredential, hasToken, ...a }: any) => a),
  bindings: v.bindings.map((b: any) => ({
    ...b,
    scopes: b.scopes.map(({ name, ...s }: any) => s),
  })),
});
function machine(
  f: Awaited<ReturnType<typeof settingsFixture>>,
  token: string,
) {
  const request = (path: string, init: RequestInit = {}) =>
    fetch(f.app.app.http!.url + path, {
      ...init,
      headers: { Authorization: "Bearer " + token, ...init.headers },
    });
  const call = (name: string, args: unknown = {}) =>
    request("/mcp", {
      method: "POST",
      headers: {
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
  const upload = () =>
    request("/assets", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: "owned test upload",
    });
  return { request, call, upload };
}

test("registered zero-binding identity lists zero accounts over actual MCP without acquiring upload/history/send/asset authority", async () => {
  const f = await settingsFixture(true);
  try {
    await f.login();
    const input = proposal(await f.app.view());
    input.agents.push({
      id: "empty",
      receiver_url: f.receiver.url,
      receiver_credential: "empty-receiver",
    });
    expect(
      (
        await f.apply("settings", {
          ...input,
          secrets: [
            {
              ref: "empty-receiver",
              account: "empty",
              kind: "receiver",
              value: "test-receiver",
            },
          ],
        })
      ).ok,
    ).toBe(true);
    const token = (
      await (
        await f.request("token", { agent_id: "empty", action: "issue" })
      ).json()
    ).token;
    expect(await f.app.app.service!.call("empty", "list_accounts", {})).toEqual(
      { items: [] },
    );
    const m = machine(f, token);
    const listing = await m.call("list_accounts");
    expect(listing.status).toBe(200);
    expect((await listing.json()).result.structuredContent).toEqual({
      items: [],
    });
    expect((await m.upload()).status).toBe(403);
    const asset = await f.app.app.service!.assets.ingest(
      new Response("owned seeded asset").body,
      "application/octet-stream",
      "seed",
      "empty",
      new AbortController().signal,
    );
    expect((await m.request("/assets/" + asset.asset_id)).status).toBe(404);
    for (const [name, args] of [
      ["list_conversations", { account_id: "ungranted" }],
      [
        "read_messages",
        { account_id: "ungranted", conversation_id: "ungranted" },
      ],
      [
        "send_message",
        {
          account_id: "ungranted",
          conversation_id: "ungranted",
          request_id: "must-not-send",
          content: [{ type: "text", text: "denied" }],
        },
      ],
      ["get_asset", { asset_id: asset.asset_id }],
    ] as const) {
      const response = await m.call(name, args);
      expect(response.status).toBe(200);
      expect((await response.json()).result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "not_found" } },
      });
    }
    expect(f.app.store.db.prepare("SELECT * FROM sends").all()).toEqual([]);
    expect(f.platform.calls).toEqual([]);
    expect((await machine(f, "wrong-token").call("list_accounts")).status).toBe(
      401,
    );
    await f.request("token", { agent_id: "empty", action: "revoke" });
    expect((await m.call("list_accounts")).status).toBe(401);
    const newToken = (
      await (
        await f.request("token", { agent_id: "empty", action: "issue" })
      ).json()
    ).token;
    const removed = proposal(await f.app.view());
    removed.agents = [];
    expect((await f.apply("settings", removed)).ok).toBe(true);
    expect((await machine(f, newToken).call("list_accounts")).status).toBe(401);
    expect((await machine(f, newToken).upload()).status).toBe(401);
  } finally {
    await f.close();
  }
});

test("fully paused HTTP/upload denial remains, removing last binding preserves identity but denies assets and other-agent access", async () => {
  const f = await settingsFixture();
  try {
    await f.login();
    const m = machine(f, f.state.token);
    const uploaded = await m.upload();
    expect(uploaded.status).toBe(201);
    const asset = await uploaded.json();
    const input = proposal(await f.app.view());
    input.agents.push({
      id: "other",
      receiver_url: f.receiver.url,
      receiver_credential: "other-empty",
    });
    await f.apply("settings", {
      ...input,
      secrets: [
        {
          ref: "other-empty",
          account: "other",
          kind: "receiver",
          value: "other-test-receiver",
        },
      ],
    });
    const otherToken = (
      await (
        await f.request("token", { agent_id: "other", action: "issue" })
      ).json()
    ).token;
    const other = machine(f, otherToken);
    expect((await other.request("/assets/" + asset.asset_id)).status).toBe(404);
    expect((await other.upload()).status).toBe(403);
    const paused = proposal(await f.app.view());
    paused.bindings[0].enabled = false;
    await f.apply("settings", paused);
    expect((await m.call("list_accounts")).status).toBe(401);
    expect((await m.upload()).status).toBe(401);
    expect((await m.request("/assets/" + asset.asset_id)).status).toBe(401);
    const removed = proposal(await f.app.view());
    removed.bindings = [];
    await f.apply("settings", removed);
    const listing = await m.call("list_accounts");
    expect(listing.status).toBe(200);
    expect((await listing.json()).result.structuredContent).toEqual({
      items: [],
    });
    expect((await m.upload()).status).toBe(403);
    expect((await m.request("/assets/" + asset.asset_id)).status).toBe(404);
    expect(f.app.store.tokens.has("cfl")).toBe(true);
    expect(await f.app.store.secret("receiver-secret", "cfl", "receiver")).toBe(
      "test-receiver",
    );
  } finally {
    await f.close();
  }
});
