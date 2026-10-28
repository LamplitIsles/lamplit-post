import { expect, test } from "vitest";
import { settingsFixture } from "./fixtures/settings";
import { until } from "./fixtures/state";
import { request as httpRequest } from "node:http";

const editable = (v: any) => ({
  version: v.version,
  agents: v.agents.map(({ hasCredential, hasToken, ...a }: any) => a),
  accounts: v.accounts.map(({ hasCredential, ready, ...a }: any) => a),
  bindings: v.bindings.map(({ hasCredential, hasToken, ...b }: any) => ({
    ...b,
    scopes: b.scopes.map(({ name, ...s }: any) => s),
  })),
});

test("new Matrix account is saved without a grant and discovers joined rooms through its live SDK", async () => {
  const f = await settingsFixture(true);
  try {
    await f.login();
    const account = {
      id: "matrix-main",
      platform: "matrix",
      native_id: "@post:fixture",
      credential: "matrix-secret",
      homeserver: f.platform.url,
    };
    const verified = await (
      await f.request("matrix/verify", {
        account,
        credential: "test-matrix-platform-secret",
      })
    ).json();
    expect(verified).toMatchObject({ verified: true });
    expect(verified.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ native_id: "!room:fixture" }),
      ]),
    );
    const proposal = editable(await (await f.request("settings")).json());
    proposal.accounts.push(account);
    proposal.agents.push({
      id: "cfl",
      receiver_url: f.receiver.url,
      receiver_credential: "receiver-secret",
    });
    proposal.bindings.push({
      id: "matrix-owner",
      agent_id: "cfl",
      account_ids: [account.id],
      scopes: [],
      wake: {},
    });
    const response = await f.request("settings", {
      ...proposal,
      secrets: [
        {
          ref: account.credential,
          account: account.id,
          kind: "platform",
          value: "test-matrix-platform-secret",
        },
      ],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      saved: true,
      applied: false,
      state: "applying",
    });
    await f.app.pending;
    expect((await (await f.request("status")).json()).applied).toBe(true);
    const view = await (await f.request("settings")).json();
    expect(view.bindings[0]).toMatchObject({
      agent_id: "cfl",
      account_ids: [account.id],
      scopes: [],
    });
    expect(JSON.stringify(view)).not.toContain("test-matrix-platform-secret");
    const discovery = await (
      await f.request("discover", { account_id: account.id })
    ).json();
    expect(discovery).toMatchObject({ source: "platform", complete: false });
    expect(discovery.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ native_id: "!room:fixture" }),
      ]),
    );
    expect(
      (await (await f.request("settings")).json()).bindings[0].scopes,
    ).toEqual([]);
    expect(f.receiver.attempts).toEqual([]);
    expect(f.platform.sendCount).toBe(0);
  } finally {
    await f.close();
  }
});

test("a lost first-save response can be resolved by readback without replay or token issuance", async () => {
  const f = await settingsFixture(true);
  try {
    const login = await f.login();
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const { csrf } = await (await f.request("session")).json();
    const before = editable(await (await f.request("settings")).json());
    const proposal = structuredClone(before);
    proposal.accounts.push({
      id: "qq-main",
      platform: "qq",
      native_id: "qq-app",
      credential: "qq-secret",
    });
    proposal.agents.push({
      id: "cfl",
      receiver_url: f.receiver.url,
      receiver_credential: "receiver-secret",
    });
    proposal.bindings.push({
      id: "qq-owner",
      agent_id: "cfl",
      account_ids: ["qq-main"],
      scopes: [],
      wake: {},
    });
    const payload = JSON.stringify({
      ...proposal,
      secrets: [
        {
          ref: "qq-secret",
          account: "qq-main",
          kind: "platform",
          value: "test-qq-platform-secret",
        },
      ],
    });
    const tokens = f.app.store.db
      .prepare("SELECT * FROM tokens ORDER BY agent")
      .all();
    let posts = 0;
    f.web.server.on("request", (req) => {
      if (req.method === "POST" && req.url === "/api/settings") posts++;
    });
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        f.config.settings.origin + "/api/settings",
        {
          method: "POST",
          headers: {
            cookie,
            origin: f.config.settings.origin,
            "X-Post-CSRF": csrf,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        },
        (res) => {
          // The client loses the response body after the server has acknowledged the save.
          res.destroy();
          resolve();
        },
      );
      req.once("error", reject);
      req.end(payload);
    });
    await until(async () => !(await (await f.request("status")).json()).busy);
    const status = await (await f.request("status")).json();
    const current = await (await f.request("settings")).json();
    expect(status).toMatchObject({ saved: true, applied: true, ready: true });
    expect(current.version).not.toBe(before.version);
    expect(current.bindings[0]).toMatchObject({
      agent_id: "cfl",
      account_ids: ["qq-main"],
      scopes: [],
    });
    expect(posts).toBe(1);
    expect(
      f.app.store.db.prepare("SELECT * FROM tokens ORDER BY agent").all(),
    ).toEqual(tokens);
    expect(f.receiver.attempts).toEqual([]);
    expect(f.platform.sendCount).toBe(0);
  } finally {
    await f.close();
  }
});

test("saved empty-scope account discovers actual QQ events without grants, then grants explicitly while retaining existing settings", async () => {
  const f = await settingsFixture(
    false,
    1500,
    undefined,
    undefined,
    undefined,
    (config) => ({
      ...config,
      accounts: config.accounts.filter((a) => a.platform === "matrix"),
      bindings: config.bindings.map((b) => ({
        ...b,
        account_ids: ["matrix-main"],
        scopes: b.scopes.filter((s) => s.account_id === "matrix-main"),
      })),
    }),
  );
  try {
    await f.login();
    const original = editable(await (await f.request("settings")).json());
    const tokens = f.app.store.db
      .prepare("SELECT * FROM tokens ORDER BY agent")
      .all();
    const proposal = structuredClone(original);
    proposal.accounts.push({
      id: "qq-main",
      platform: "qq",
      native_id: "qq-app",
      credential: "qq-secret",
    });
    proposal.bindings.push({
      id: "qq-owner",
      agent_id: "cfl",
      account_ids: ["qq-main"],
      scopes: [],
      wake: {},
    });
    const response = await f.request("settings", {
      ...proposal,
      secrets: [
        {
          ref: "qq-secret",
          account: "qq-main",
          kind: "platform",
          value: "test-qq-platform-secret",
        },
      ],
    });
    expect(response.status).toBe(200);
    const ack = await response.json();
    expect(ack).toMatchObject({
      saved: true,
      applied: false,
      state: "applying",
    });
    await f.app.pending;
    const status = await (await f.request("status")).json();
    expect(status).toMatchObject({
      applied: true,
      ready: true,
      accepted_version: ack.accepted_version,
      active_version: ack.accepted_version,
    });
    const saved = editable(await (await f.request("settings")).json());
    expect(saved.bindings[0]).toEqual(original.bindings[0]);
    expect(saved.bindings[1]).toMatchObject({
      agent_id: "cfl",
      account_ids: ["qq-main"],
      scopes: [],
    });
    expect((await f.request("settings", proposal)).status).toBe(409);

    const matrix = await (
      await f.request("discover", { account_id: "matrix-main" })
    ).json();
    expect(matrix).toMatchObject({ source: "platform", complete: false });
    expect(matrix.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ native_id: "!room:fixture" }),
      ]),
    );
    const empty = await (
      await f.request("discover", { account_id: "qq-main" })
    ).json();
    expect(empty).toEqual({
      items: [],
      source: "local",
      complete: false,
      reason: "qq_directory_unsupported",
    });
    f.platform.sendQQ("C2C_MESSAGE_CREATE", "owned fixture message", {
      id: "new-private",
      group_id: undefined,
      group_openid: undefined,
      author: { id: "fixture-peer" },
    });
    await until(
      () =>
        f.app.store.db
          .prepare("SELECT count(*) n FROM messages WHERE account=?")
          .get("qq-main")!.n === 1,
    );
    const discovered = await (
      await f.request("discover", { account_id: "qq-main" })
    ).json();
    const candidate = discovered.items.find(
      (item: any) => item.native_id === "fixture-peer",
    );
    expect(candidate).toMatchObject({ type: "direct", source: "observed" });
    expect(f.receiver.attempts).toEqual([]);
    expect(
      f.app.store.db.prepare("SELECT count(*) n FROM deliveries").get()!.n,
    ).toBe(0);
    await expect(
      f.app.app.service!.call("cfl", "read_messages", {
        account_id: "qq-main",
        conversation_name: candidate.name,
      }),
    ).rejects.toThrow();

    const grant = editable(await (await f.request("settings")).json());
    grant.bindings[1].scopes.push({
      account_id: "qq-main",
      conversation_id: candidate.conversation_id,
      native_id: candidate.native_id,
      type: "direct",
      senders: [candidate.native_id],
    });
    grant.bindings[1].wake = { direct: true };
    expect((await f.request("settings", grant)).status).toBe(200);
    await f.app.pending;
    expect((await (await f.request("status")).json()).applied).toBe(true);
    const final = editable(await (await f.request("settings")).json());
    expect(final.bindings[0]).toEqual(original.bindings[0]);
    expect(final.bindings[1].scopes).toEqual(grant.bindings[1].scopes);
    expect(final.bindings[1].wake).toEqual(
      expect.objectContaining({ direct: true }),
    );
    expect(
      f.app.store.db.prepare("SELECT * FROM tokens ORDER BY agent").all(),
    ).toEqual(tokens);
    const history = (await f.app.app.service!.call("cfl", "read_messages", {
      account_id: "qq-main",
      conversation_name: candidate.name,
    })) as any;
    expect(history.items).toHaveLength(1);
    f.platform.sendQQ("C2C_MESSAGE_CREATE", "after grant", {
      id: "after-grant",
      group_id: undefined,
      group_openid: undefined,
      author: { id: "fixture-peer" },
    });
    await until(() => f.receiver.attempts.length === 1);
    expect(f.platform.sendCount).toBe(0);
  } finally {
    await f.close();
  }
});
