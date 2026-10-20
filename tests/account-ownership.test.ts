import { test, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { ConfigSchema } from "../src/config";
import { settingsFixture } from "./fixtures/settings";
import { until } from "./fixtures/state";

const editable = (v: any) => ({
  version: v.version,
  accounts: v.accounts.map(({ hasCredential, ready, ...a }: any) => a),
  agents: v.agents.map(({ hasCredential, hasToken, ...a }: any) => a),
  bindings: v.bindings.map((b: any) => ({
    ...b,
    scopes: b.scopes.map(({ name, ...s }: any) => s),
  })),
});
const other = {
  id: "other",
  receiver_url: "http://127.0.0.1:19999",
  receiver_credential: "other-receiver",
};

test("configuration requires exactly one distinct owner while permitting multiple accounts/bindings for one agent", async () => {
  const f = await settingsFixture();
  try {
    const base = structuredClone(f.app.config);
    const second = { ...base.bindings[0]!, id: "second", scopes: [] };
    expect(
      ConfigSchema.safeParse({ ...base, bindings: [...base.bindings, second] })
        .success,
    ).toBe(true);
    expect
      .soft(
        ConfigSchema.safeParse({
          ...base,
          agents: [...base.agents, other],
          bindings: [...base.bindings, { ...second, agent_id: other.id }],
        }).success,
      )
      .toBe(false);
    expect
      .soft(ConfigSchema.safeParse({ ...base, bindings: [] }).success)
      .toBe(false);
    const extra = {
      ...base.accounts[0]!,
      id: "second-qq",
      native_id: "second-native",
      credential: "second-credential",
    };
    expect(
      ConfigSchema.safeParse({
        ...base,
        accounts: [...base.accounts, extra],
        bindings: [
          {
            ...base.bindings[0]!,
            account_ids: [...base.bindings[0]!.account_ids, extra.id],
          },
        ],
      }).success,
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test("settings rejects sharing, orphaning and retained ownership transfer atomically; native intake serves only its owner", async () => {
  const f = await settingsFixture();
  const apply = async (v: any) => f.apply("settings", v);
  const call = async (token: string, name: string, args: any = {}) => {
    const r = await fetch(f.app.app.http!.url + "/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
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
    return (await r.json()).result.structuredContent;
  };
  try {
    await f.login();
    f.platform.sendQQ("GROUP_AT_MESSAGE_CREATE", "owned immutable history", {
      id: "ownership-history",
    });
    await until(
      () =>
        f.app.store.db.prepare("SELECT state FROM deliveries").get()?.state ===
        "accepted",
    );
    const history = f.app.store.db
      .prepare("SELECT id,body FROM messages ORDER BY seq")
      .all();
    const snapshots = f.app.store.db
      .prepare("SELECT id,body,receiver FROM deliveries ORDER BY seq")
      .all();
    const tokens = f.app.store.db
      .prepare("SELECT * FROM tokens ORDER BY agent")
      .all();
    const key = await readFile(f.app.config.master_key_file);
    const initial = editable(await f.app.view());
    expect(
      (
        await apply({
          ...initial,
          agents: [
            ...initial.agents,
            { ...other, receiver_url: f.receiver.url },
          ],
          secrets: [
            {
              ref: other.receiver_credential,
              account: other.id,
              kind: "receiver",
              value: "test-receiver",
            },
          ],
        })
      ).status,
    ).toBe(200);
    const v = editable(await f.app.view());
    const original = await readFile(f.path, "utf8");
    const vault = f.app.store.db
      .prepare("SELECT * FROM vault ORDER BY ref")
      .all();
    const pin = f.app.store.db
      .prepare("SELECT * FROM identities ORDER BY account")
      .all();
    const second = {
      ...v.bindings[0],
      id: "other-binding",
      agent_id: other.id,
      account_ids: ["qq-main"],
      scopes: [],
    };
    for (const bindings of [
      [...v.bindings, second],
      [],
      [
        {
          ...v.bindings[0],
          account_ids: ["matrix-main"],
          scopes: v.bindings[0].scopes.filter(
            (s: any) => s.account_id !== "qq-main",
          ),
        },
        second,
      ],
    ]) {
      expect.soft((await apply({ ...v, bindings })).status).not.toBe(200);
      expect.soft(await readFile(f.path, "utf8")).toBe(original);
      expect
        .soft(f.app.store.db.prepare("SELECT * FROM vault ORDER BY ref").all())
        .toEqual(vault);
      expect
        .soft(
          f.app.store.db
            .prepare("SELECT * FROM identities ORDER BY account")
            .all(),
        )
        .toEqual(pin);
      expect(
        f.app.store.db
          .prepare("SELECT id,body FROM messages ORDER BY seq")
          .all(),
      ).toEqual(history);
      expect(
        f.app.store.db
          .prepare("SELECT id,body,receiver FROM deliveries ORDER BY seq")
          .all(),
      ).toEqual(snapshots);
      expect(
        f.app.store.db.prepare("SELECT * FROM tokens ORDER BY agent").all(),
      ).toEqual(tokens);
      expect(await readFile(f.app.config.master_key_file)).toEqual(key);
    }
    // Clearing grants preserves ownership, and does not authorize or wake.
    const originalScopes = v.bindings[0].scopes;
    expect(
      (
        await apply({
          ...editable(await f.app.view()),
          bindings: [{ ...v.bindings[0], scopes: [] }],
        })
      ).status,
    ).toBe(200);
    f.platform.sendQQ("GROUP_AT_MESSAGE_CREATE", "owned pregrant", {
      id: "ownership-pregrant",
    });
    await until(
      () =>
        !!f.app.store.db
          .prepare("SELECT id FROM messages WHERE native='ownership-pregrant'")
          .get(),
    );
    expect(f.receiver.attempts).toHaveLength(1);
    expect((await f.app.view()).bindings[0]!.account_ids).toEqual([
      "qq-main",
      "matrix-main",
    ]);
    const otherToken = await f.app.store.issue(other.id);
    expect((await call(otherToken, "list_accounts")).items).toEqual([]);
    expect(
      (
        await call(otherToken, "read_messages", {
          account_id: "qq-main",
          conversation_id: "qq-group",
        })
      ).error.code,
    ).toBe("not_found");
    expect(
      (
        await apply({
          ...editable(await f.app.view()),
          bindings: [{ ...v.bindings[0], scopes: originalScopes }],
        })
      ).status,
    ).toBe(200);
    // Defensive runtime checks reject a foreign scope even if a caller bypasses config parsing.
    f.app.config.bindings.push({
      ...second,
      account_ids: [],
      scopes: originalScopes,
    });
    expect(f.app.app.service!.hasGrants(other.id)).toBe(false);
    expect.soft((await call(otherToken, "list_accounts")).items).toEqual([]);
    expect
      .soft(
        (
          await call(otherToken, "get_conversation", {
            account_id: "qq-main",
            conversation_id: "qq-group",
          })
        ).error?.code,
      )
      .toBe("not_found");
    f.platform.sendQQ("GROUP_AT_MESSAGE_CREATE", "owned granted", {
      id: "ownership-granted",
    });
    await until(
      () =>
        Number(
          f.app.store.db
            .prepare("SELECT count(*) n FROM deliveries WHERE state='accepted'")
            .get()!.n,
        ) >= 2,
    );
    expect
      .soft(f.receiver.attempts.map((body) => JSON.parse(body).agent_id))
      .toEqual(["cfl", "cfl"]);
    expect(
      (
        await call(otherToken, "send_message", {
          account_id: "qq-main",
          conversation_id: "qq-group",
          request_id: "foreign",
          content: [{ type: "text", text: "must not send" }],
        })
      ).error?.code,
    ).toBe("not_found");
    expect(f.platform.sendCount).toBe(0);
  } finally {
    await f.close();
  }
});
