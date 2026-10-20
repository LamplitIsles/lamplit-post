import { test, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { parse } from "smol-toml";
import { settingsFixture } from "./fixtures/settings";
import { until } from "./fixtures/state";
import { httpFixture } from "./fixtures/http";
import { PostEventV1 } from "../contracts/v1/index";

const editable = (v: any) => ({
  version: v.version,
  accounts: v.accounts.map(({ hasCredential, ready, ...a }: any) => a),
  agents: v.agents.map(({ hasCredential, hasToken, ...a }: any) => a),
  bindings: v.bindings.map((b: any) => ({
    ...b,
    scopes: b.scopes.map(({ name, ...s }: any) => s),
  })),
});

test("owned caller Matrix then QQ zero-grant association, observed candidates then explicit grant, one authenticated receiver", async () => {
  const f = await settingsFixture(true);
  const view = async () => (await f.request("settings")).json();
  const save = async (input: any) => {
    const r = await f.apply("settings", input);
    expect(r.status).toBe(200);
    const result = await r.json();
    expect(result.applied).toBe(true);
    return result;
  };
  try {
    await f.login();
    let v = editable(await view());
    v.agents.push({
      id: "one",
      name: "One",
      receiver_url: f.receiver.url,
      receiver_credential: "one-receiver",
    });
    await save({
      ...v,
      secrets: [
        {
          ref: "one-receiver",
          account: "one",
          kind: "receiver",
          value: "test-receiver",
        },
      ],
    });
    await f.request("token", { agent_id: "one", action: "issue" });
    const matrix = f.state.config.accounts[1]!;
    const verification = await (
      await f.request("matrix/verify", {
        account: matrix,
        credential: "test-matrix-platform-secret",
      })
    ).json();
    expect(verification.verified).toBe(true);
    const room = verification.items.find(
      (r: any) => r.native_id === "!room:fixture",
    );
    v = editable(await view());
    v.accounts.push(matrix);
    v.bindings.push({
      id: "both",
      agent_id: "one",
      account_ids: [matrix.id],
      scopes: [
        {
          account_id: matrix.id,
          conversation_id: room.conversation_id,
          native_id: room.native_id,
          type: "group",
          senders: [],
        },
      ],
      wake: { mention: true },
    });
    await save({
      ...v,
      conversation_names: [
        {
          account_id: matrix.id,
          conversation_id: room.conversation_id,
          name: "Readable <room>",
        },
      ],
      secrets: [
        {
          ref: matrix.credential,
          account: matrix.id,
          kind: "platform",
          value: "test-matrix-platform-secret",
        },
      ],
    });
    const qq = f.state.config.accounts[0]!;
    v = editable(await view());
    v.accounts.push(qq);
    v.bindings[0].account_ids.push(qq.id);
    await save({
      ...v,
      secrets: [
        {
          ref: qq.credential,
          account: qq.id,
          kind: "platform",
          value: "test-qq-platform-secret",
        },
      ],
    });
    const saved = parse(await readFile(f.path, "utf8")) as any;
    expect(saved.bindings[0].account_ids).toEqual([matrix.id, qq.id]);
    expect(saved.bindings[0].scopes).toHaveLength(1);
    expect((await view()).bindings[0].scopes[0].name).toBe("Readable <room>");
    const before = await (
      await f.request("discover", { account_id: qq.id })
    ).json();
    expect(before.items).toEqual([]);
    const sends = f.platform.calls.filter((r) => r.path.includes("messages"));
    f.platform.sendQQ("GROUP_AT_MESSAGE_CREATE", "<@qq-app> discover", {
      group_openid: "owned-openid",
      group_id: "owned-openid",
    });
    await until(() =>
      f.app.store.db
        .prepare("SELECT id FROM conversations WHERE native=?")
        .get("owned-openid"),
    );
    let candidates = await (
      await f.request("discover", { account_id: qq.id })
    ).json();
    const candidate = candidates.items.find(
      (c: any) => c.native_id === "owned-openid",
    );
    expect(candidate.source).toBe("observed");
    expect(f.receiver.attempts).toEqual([]);
    expect(f.app.store.db.prepare("SELECT id FROM deliveries").all()).toEqual(
      [],
    );
    expect(f.platform.calls.filter((r) => r.path.includes("messages"))).toEqual(
      sends,
    );
    v = editable(await view());
    v.bindings[0].scopes.push({
      account_id: qq.id,
      conversation_id: candidate.conversation_id,
      native_id: candidate.native_id,
      type: "group",
      senders: [],
    });
    await save(v);
    f.platform.sendQQ("GROUP_AT_MESSAGE_CREATE", "<@qq-app> granted", {
      group_openid: "owned-openid",
      group_id: "owned-openid",
    });
    f.platform.sendMatrix({
      body: "hello",
      msgtype: "m.text",
      "m.mentions": { user_ids: [matrix.native_id] },
    });
    await until(() => f.receiver.attempts.length === 2);
    expect(
      new Set(
        f.receiver.attempts.map(
          (b) => PostEventV1.parse(JSON.parse(b)).message.platform,
        ),
      ),
    ).toEqual(new Set(["matrix", "qq"]));
    expect(
      f.app.store.db
        .prepare(
          "SELECT ref FROM vault WHERE kind='receiver' AND account='one'",
        )
        .all(),
    ).toHaveLength(1);
    // Editing one scope leaves the other account and identity pins untouched.
    const pins = f.app.store.db
      .prepare("SELECT id,account,native,type FROM conversations ORDER BY id")
      .all();
    v = editable(await view());
    v.bindings[0].scopes = v.bindings[0].scopes.filter(
      (s: any) => s.account_id !== qq.id,
    );
    await save(v);
    expect((await view()).bindings[0].account_ids).toEqual([matrix.id, qq.id]);
    expect(
      f.app.store.db
        .prepare("SELECT id,account,native,type FROM conversations ORDER BY id")
        .all(),
    ).toEqual(pins);
    v = editable(await view());
    v.bindings = [];
    await save(v);
    expect((await view()).agents[0].hasToken).toBe(true);
    expect(await f.app.store.secret("one-receiver", "one", "receiver")).toBe(
      "test-receiver",
    );
  } finally {
    await f.close();
  }
});

test("connection rotation authenticates both SDK channels, changed destination holds old snapshots, other agent isolated", async () => {
  const f = await settingsFixture();
  const captures: any[] = [];
  let secret = "rotated";
  const receiver = await httpFixture(async (req) => {
    if (req.headers.get("authorization") !== "Bearer " + secret)
      return new Response(null, { status: 401 });
    captures.push(PostEventV1.parse(await req.json()));
    return new Response(null, { status: 204 });
  });
  try {
    await f.login();
    const configured = await (
      await f.request("discover", { account_id: "qq-main" })
    ).json();
    expect(
      configured.items.find((c: any) => c.native_id === "qq-group").source,
    ).toBe("configured");
    let v = editable(await f.app.view());
    v.agents.push({
      id: "other",
      receiver_url: f.receiver.url,
      receiver_credential: "other-secret",
    });
    v.bindings.push({
      ...structuredClone(v.bindings[0]),
      id: "other-binding",
      agent_id: "other",
    });
    expect(
      (
        await f.apply("settings", {
          ...v,
          secrets: [
            {
              ref: "other-secret",
              account: "other",
              kind: "receiver",
              value: "test-receiver",
            },
          ],
        })
      ).ok,
    ).toBe(true);
    await f.app.store.issue("other");
    v = editable(await f.app.view());
    // Existing pending recipient stays byte-identical when agent URL changes.
    f.platform.sendQQ("GROUP_AT_MESSAGE_CREATE", "before rotation");
    await until(() => f.receiver.attempts.length >= 2);
    const immutable = f.app.store.db
      .prepare(
        "SELECT id,receiver,body FROM deliveries WHERE agent='cfl' LIMIT 1",
      )
      .get()!;
    v.agents[0].receiver_url = `http://127.0.0.1:${receiver.port}`;
    await f.apply("settings", {
      ...v,
      secrets: [
        {
          ref: v.agents[0].receiver_credential,
          account: "cfl",
          kind: "receiver",
          value: secret,
        },
      ],
    });
    f.platform.sendQQ("GROUP_AT_MESSAGE_CREATE", "rotated qq");
    f.platform.sendMatrix({
      body: "rotated matrix",
      msgtype: "m.text",
      "m.mentions": { user_ids: ["@post:fixture"] },
    });
    await until(() => captures.length === 2);
    expect(captures.every((e) => e.agent_id === "cfl")).toBe(true);
    expect(new Set(captures.map((e) => e.message.platform))).toEqual(
      new Set(["matrix", "qq"]),
    );
    expect(await f.app.store.secret("other-secret", "other", "receiver")).toBe(
      "test-receiver",
    );
    // Same recipient rotation changes only auth, and blank-secret save preserves it.
    secret = "rotated-again";
    v = editable(await f.app.view());
    await f.apply("settings", {
      ...v,
      secrets: [
        {
          ref: v.agents[0].receiver_credential,
          account: "cfl",
          kind: "receiver",
          value: secret,
        },
      ],
    });
    await f.apply("settings", editable(await f.app.view()));
    f.platform.sendQQ("GROUP_AT_MESSAGE_CREATE", "second rotation");
    await until(() => captures.length === 3);
    f.app.store.db
      .prepare("UPDATE deliveries SET state='pending',due=0 WHERE id=?")
      .run(immutable.id);
    await until(
      () =>
        f.app.store.db
          .prepare("SELECT state FROM deliveries WHERE id=?")
          .get(immutable.id)?.state === "held",
    );
    expect(
      f.app.store.db
        .prepare("SELECT id,receiver,body FROM deliveries WHERE id=?")
        .get(immutable.id),
    ).toEqual(immutable);
    const bad = editable(await f.app.view());
    expect(
      (
        await f.request("settings", {
          ...bad,
          secrets: [
            {
              ref: "other-secret",
              account: "cfl",
              kind: "receiver",
              value: "wrong-owner",
            },
          ],
        })
      ).status,
    ).toBe(400);
  } finally {
    await f.close();
    await receiver.stop();
  }
});

test("Matrix SDK labels are bounded display-only metadata, missing fallback and offline reopen preserve pins and ACL", async () => {
  const f = await settingsFixture();
  try {
    await f.login();
    const pins = f.app.store.db
      .prepare("SELECT id,account,native,type FROM conversations ORDER BY id")
      .all();
    f.platform.roomName("<script>owned</script>" + "长".repeat(600));
    const verified = await (
      await f.request("matrix/verify", { account: f.config.accounts[1] })
    ).json();
    const room = verified.items.find(
      (c: any) => c.native_id === "!room:fixture",
    );
    expect(room.name.length).toBe(256);
    const input = editable(await f.app.view());
    const names = [
      {
        account_id: "matrix-main",
        conversation_id: "matrix-room",
        name: room.name,
      },
    ];
    expect(
      (await f.apply("settings", { ...input, conversation_names: names })).ok,
    ).toBe(true);
    expect(
      (await f.app.view()).bindings[0]!.scopes.find(
        (s) => s.conversation_id === "matrix-room",
      )!.name,
    ).toBe(room.name);
    expect(
      f.app.store.db
        .prepare("SELECT id,account,native,type FROM conversations ORDER BY id")
        .all(),
    ).toEqual(pins);
    await expect(
      f.app.app.service!.call("cfl", "get_conversation", {
        account_id: "matrix-main",
        conversation_id: "ungranted",
      }),
    ).rejects.toThrow();
    f.platform.roomName("");
    const missing = await (
      await f.request("matrix/verify", { account: f.config.accounts[1] })
    ).json();
    expect(missing.items[0].name || missing.items[0].native_id).toBe(
      missing.items[0].native_id,
    );
    for (const account_ids of [
      ["qq-main"],
      ["matrix-main", "matrix-main"],
      ["unconfigured"],
    ]) {
      const bad = editable(await f.app.view());
      bad.bindings[0].account_ids = account_ids;
      expect((await f.request("settings", bad)).status).toBe(400);
    }
    const { Store } = await import("../src/store");
    await f.app.stop();
    const reopened = await Store.open(f.app.config);
    try {
      expect(
        reopened.db
          .prepare("SELECT name FROM conversations WHERE id='matrix-room'")
          .get()?.name,
      ).toBe(room.name);
      expect(
        reopened.db
          .prepare(
            "SELECT id,account,native,type FROM conversations ORDER BY id",
          )
          .all(),
      ).toEqual(pins);
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});
