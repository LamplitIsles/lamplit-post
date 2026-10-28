import { test, expect } from "vitest";
import { writeFile, readFile, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { stringify } from "smol-toml";
import { Settings } from "../src/settings";
import { serveSettings } from "../src/management";
import { provisionAdmin } from "../src/admin";
import { platformsFixture } from "./fixtures/platforms";
import { stateFixture, until } from "./fixtures/state";
import { consumerFixture } from "./fixtures/consumer";
import { Store } from "../src/store";
import { settingsFixture } from "./fixtures/settings";
const editable = (v: any) => ({
  version: v.version,
  agents: v.agents.map(({ hasCredential, hasToken, ...a }: any) => a),
  accounts: v.accounts.map(({ hasCredential, ready, ...a }: any) => a),
  bindings: v.bindings.map(({ hasCredential, hasToken, ...b }: any) => ({
    ...b,
    scopes: b.scopes.map(({ name, ...s }: any) => s),
  })),
});
test("real management login, persisted empty registration, stale/CSRF/channel rejection and reload", async () => {
  const f = await settingsFixture(true);
  try {
    expect((await f.request("settings")).status).toBe(401);
    expect(
      (
        await f.apply("settings", undefined, {
          Authorization: "Bearer " + f.state.token,
        })
      ).status,
    ).toBe(401);
    expect((await f.request("login", { password: "wrong" })).status).toBe(401);
    await f.login();
    const initial = await (await f.request("settings")).json();
    expect(initial.bindings).toEqual([]);
    const update = editable(initial);
    update.agents.push({
      id: "manual",
      name: "First agent",
      receiver_url: f.receiver.url,
      receiver_credential: "manual-secret",
    });
    const before = await readFile(f.path, "utf8");
    expect(
      (await f.apply("settings", update, { "X-Post-CSRF": "wrong" })).status,
    ).toBe(401);
    expect(
      (await f.apply("settings", update, { origin: "https://evil.example" }))
        .status,
    ).toBe(401);
    expect(await readFile(f.path, "utf8")).toBe(before);
    const owner = f.app.store;
    const saved = await (
      await f.apply("settings", {
        ...update,
        secrets: [
          {
            ref: "manual-secret",
            account: "manual",
            kind: "receiver",
            value: "distinct-receiver-fixture",
          },
        ],
      })
    ).json();
    expect(saved.applied).toBe(true);
    expect(f.app.store).toBe(owner);
    expect(owner.owner.closed).toBe(false);
    await expect(Store.open(f.config)).rejects.toThrow();
    expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    expect((await f.apply("settings", update)).status).toBe(409);
    const text = JSON.stringify(saved);
    expect(text).not.toContain("distinct-receiver-fixture");
    expect(text).not.toContain("owned-fixture-password");
    const token = await (
      await f.request("token", { agent_id: "manual", action: "issue" })
    ).json();
    expect(typeof token.token).toBe("string");
    expect(
      await f.app.app.service!.call("manual", "list_accounts", {}),
    ).toEqual({ items: [] });
    const replay = await (await f.request("settings")).json();
    expect(JSON.stringify(replay)).not.toContain(token.token);
    await f.request("logout", {});
    expect((await f.request("settings")).status).toBe(401);
    await f.app.stop();
    const reopened = await Store.open(f.app.config);
    expect(await reopened.secret("manual-secret", "manual", "receiver")).toBe(
      "distinct-receiver-fixture",
    );
    await reopened.close();
  } finally {
    await f.close();
  }
});
test("SDK configuration restart preserves exclusive owner, pins, unknown sends, same-owner binding ACL and paused delivery", async () => {
  const f = await settingsFixture();
  try {
    await f.login();
    const initial = editable(await (await f.request("settings")).json());
    const store = f.app.store;
    const before = await readFile(f.path, "utf8");
    for (const mutate of [
      (x: any) => (x.accounts[0].native_id = "wrong"),
      (x: any) => (x.bindings[0].scopes[0].native_id = "wrong"),
      (x: any) => (x.bindings[0].scopes[0].conversation_id = "remapped"),
    ]) {
      const bad = structuredClone(initial);
      mutate(bad);
      expect((await f.apply("settings", bad)).status).toBe(409);
      expect(await readFile(f.path, "utf8")).toBe(before);
      expect(f.app.app.service!.closed).toBe(false);
    }
    f.platform.sendQQ("GROUP_MESSAGE_CREATE", "ordinary");
    await until(() => !!store.db.prepare("SELECT id FROM messages").get());
    const unknownInput = {
      agent: "cfl",
      request: "pending-unknown",
      input: "{}",
    };
    store.db
      .prepare("INSERT INTO sends(agent,request,input) VALUES (?,?,?)")
      .run(unknownInput.agent, unknownInput.request, unknownInput.input);
    const update = structuredClone(initial);
    update.bindings[0].enabled = false;
    update.bindings.push({
      ...structuredClone(update.bindings[0]),
      id: "second",
      agent_id: "cfl",

      enabled: true,
      scopes: [update.bindings[0].scopes[0]],
    });
    update.agents.push({
      id: "second",
      receiver_url: f.receiver.url,
      receiver_credential: "second-secret",
    });
    const response = await (
      await f.apply("settings", {
        ...update,
        secrets: [
          {
            ref: "second-secret",
            account: "second",
            kind: "receiver",
            value: "second-receiver",
          },
        ],
      })
    ).json();
    expect(response.applied).toBe(true);
    await store.issue("second");
    await expect(
      f.app.app.service!.call("second", "read_messages", {
        account_id: "qq-main",
        conversation_name: "QQ 群聊 1",
      }),
    ).rejects.toThrow();
    expect(
      (
        (await f.app.app.service!.call("cfl", "read_messages", {
          account_id: "qq-main",
          conversation_name: "QQ 群聊 1",
        })) as any
      ).items.length,
    ).toBe(1);
    const discovered = await (
      await f.request("discover", { account_id: "matrix-main" })
    ).json();
    expect(discovered.source).toBe("platform");
    expect(
      discovered.items.some((i: any) => i.native_id === "!room:fixture"),
    ).toBe(true);
    const qq = await (
      await f.request("discover", { account_id: "qq-main" })
    ).json();
    expect(qq.complete).toBe(false);
    expect(qq.source).toBe("local");
    expect(
      qq.items.find((i: any) => i.conversation_id === "qq-group").source,
    ).toBe("observed");
    expect(
      qq.items.find((i: any) => i.conversation_id === "qq-dm").source,
    ).toBe("configured");
    expect(f.app.store).toBe(store);
    expect(
      store.db
        .prepare("SELECT result FROM sends WHERE request=?")
        .get("pending-unknown")?.result,
    ).toBeNull();
  } finally {
    await f.close();
  }
});
test("genuine share QR round trips; wrong origins, credential links and secret disclosure are rejected", async () => {
  const f = await settingsFixture(true);
  try {
    const link =
      "https://qun.qq.com/qunpro/robot/share?robot_appid=fixture-public-id";
    expect((await f.request("qr", { url: link })).status).toBe(401);
    await f.login();
    for (const url of [
      "javascript:alert(1)",
      "https://qun.qq.com.evil.example/share",
      "https://secret@qun.qq.com/share",
      "https://qun.qq.com/share?AppSecret=bad",
    ])
      expect((await f.request("qr", { url })).status).toBe(400);
    const qr = await (await f.request("qr", { url: link })).json();
    expect(qr.source).toBe("operator_official_share");
    expect(qr.automatic).toBe(false);
    const { PNG } = await import("pngjs"),
      { default: jsQR } = await import("jsqr");
    const png = PNG.sync.read(Buffer.from(qr.image.split(",")[1], "base64"));
    expect(
      jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data,
    ).toBe(link);
  } finally {
    await f.close();
  }
});
test("failed SDK readiness restores TOML and sealed credentials, then retry applies", async () => {
  const f = await settingsFixture();
  try {
    await f.login();
    const text = await readFile(f.path, "utf8");
    const initial = editable(await (await f.request("settings")).json());
    // A new Matrix account has a mismatched whoami, with no unbounded connection wait.
    initial.accounts.push({
      id: "wrong-matrix",
      platform: "matrix",
      native_id: "@wrong:fixture",
      credential: "wrong-platform",
      homeserver: f.platform.url,
    });
    initial.bindings[0].account_ids.push("wrong-matrix");
    const saved = await (
      await f.apply("settings", {
        ...initial,
        secrets: [
          {
            ref: "wrong-platform",
            account: "wrong-matrix",
            kind: "platform",
            value: "isolated-wrong-token",
          },
        ],
      })
    ).json();
    expect(saved.applied).toBe(false);
    expect(saved.saved).toBe(false);
    expect(saved.state).toBe("failed_recovered");
    expect(await readFile(f.path, "utf8")).toBe(text);
    expect(
      f.app.store.db
        .prepare("SELECT ref FROM vault WHERE ref=?")
        .get("wrong-platform"),
    ).toBeUndefined();
    expect(f.app.app.service!.closed).toBe(false);
    const retry = editable(await (await f.request("settings")).json());
    retry.bindings[0].wake.aliases = ["retry"];
    expect((await (await f.apply("settings", retry)).json()).applied).toBe(
      true,
    );
  } finally {
    await f.close();
  }
});
test("actual native send and immutable pending delivery retire across settings apply without automatic resend", async () => {
  const f = await settingsFixture();
  try {
    await f.login();
    const service = f.app.app.service!,
      store = f.app.store;
    f.platform.stall();
    const input = {
      account_id: "qq-main",
      conversation_name: "QQ 群聊 1",
      request_id: "during-settings-apply",
      content: [{ type: "text", text: "fixture-native-pending" }],
    };
    const send = service.call("cfl", "send_message", input);
    await until(() =>
      f.platform.calls.some((c) => c.path.endsWith("/messages")),
    );
    const pendingBody = JSON.stringify({ fixture: "immutable" });
    // A held snapshot must not be rerouted to the new receiver.
    store.db
      .prepare(
        "INSERT INTO deliveries(id,binding,agent,message,receiver,body,state) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        "immutable-held",
        "cfl-binding",
        "cfl",
        "missing-message",
        f.receiver.url,
        pendingBody,
        "held",
      );
    const update = editable(await (await f.request("settings")).json());
    update.bindings[0].enabled = false;
    const response = await (await f.apply("settings", update)).json();
    expect(response.applied).toBe(true);
    const result = await send;
    expect(result.status).toBe("unknown");
    const calls = f.platform.calls.filter((c) =>
      c.path.endsWith("/messages"),
    ).length;
    expect(
      (
        await f.app.app
          .service!.call("cfl", "send_message", input)
          .catch(() => ({ status: "denied" }))
      ).status,
    ).toBe("denied");
    const snapshot = store.db
      .prepare("SELECT * FROM deliveries WHERE id=?")
      .get("immutable-held");
    expect(snapshot?.body).toBe(pendingBody);
    expect(snapshot?.receiver).toBe(f.receiver.url);
    const retry = editable(await (await f.request("settings")).json());
    retry.bindings[0].enabled = true;
    f.platform.stall(false);
    expect((await (await f.apply("settings", retry)).json()).applied).toBe(
      true,
    );
    expect(
      (await f.app.app.service!.call("cfl", "send_message", input)).status,
    ).toBe("unknown");
    expect(
      f.platform.calls.filter((c) => c.path.endsWith("/messages")).length,
    ).toBe(calls);
  } finally {
    await f.close();
  }
});
test("bounded bodies, host checks, login throttling, finite sessions and immutable paths", async () => {
  const f = await settingsFixture(true);
  try {
    for (let n = 0; n < 5; n++)
      expect((await f.request("login", { password: "wrong" })).status).toBe(
        401,
      );
    expect(
      (await f.request("login", { password: "owned-fixture-password" })).status,
    ).toBe(401);
    const { Admin } = await import("../src/admin");
    const admin = new Admin();
    const token = await admin.login(
      f.config.settings.admin_file,
      "owned-fixture-password",
    );
    expect(token).toBeTruthy();
    admin.session(token!)!.expires = 0;
    expect(admin.session(token!)).toBeUndefined();
    expect(
      (await f.request("login", { password: "x".repeat(140000) })).status,
    ).toBe(400);
    expect(
      (await f.request("session", undefined, { host: "evil.example" })).status,
    ).toBe(401);
    const previous = await readFile(f.path, "utf8");
    await expect(
      f.app.save({
        version: (await f.app.view()).version,
        accounts: [],
        bindings: [],
        data_dir: "/elsewhere",
      }),
    ).rejects.toThrow();
    expect(await readFile(f.path, "utf8")).toBe(previous);
    expect(f.app.config.data_dir).toBe(f.config.data_dir);
    // External TOML edits cannot be paired with a stale running DTO and overwritten.
    await writeFile(
      f.path,
      (await readFile(f.path, "utf8")) + "\n# owned external edit\n",
    );
    await expect(f.app.view()).rejects.toThrow();
    expect(await readFile(f.path, "utf8")).not.toBe(previous);
  } finally {
    await f.close();
  }
});
test("settings shutdown drains a cancelled apply and startup before releasing its sole owner", async () => {
  const f = await settingsFixture();
  try {
    await f.login();
    const initial = editable(await (await f.request("settings")).json());
    const before = f.platform.calls.filter(
      (c) => c.path === "/app/getAppAccessToken",
    ).length;
    f.platform.tokenStall(true);
    const applying = f.request("settings", initial).catch(() => undefined);
    await until(
      () =>
        f.platform.calls.filter((c) => c.path === "/app/getAppAccessToken")
          .length > before,
    );
    const managementStopped = f.web.stop();
    await f.app.stop();
    await managementStopped;
    await applying;
    expect(f.platform.aborts).toBeGreaterThan(0);
    const reopened = await Store.open(f.config);
    await reopened.close();
    // Immediate startup cancellation also covers resources acquired after the first await.
    const next = new Settings(f.path, f.config, {
      qqOrigin: f.platform.url,
      qqGateway: f.platform.gateway,
    });
    const starting = next.start().catch((error) => error);
    await next.stop();
    expect(await starting).toBeInstanceOf(Error);
    const after = await Store.open(f.config);
    await after.close();
  } finally {
    await f.close();
  }
});
test("pausing the last binding removes machine HTTP and asset upload authority", async () => {
  const f = await settingsFixture();
  try {
    await f.login();
    const headers = {
      Authorization: "Bearer " + f.state.token,
      "Content-Type": "application/octet-stream",
    };
    const upload = await fetch(f.app.app.http!.url + "/assets", {
      method: "POST",
      headers,
      body: "owned fixture bytes",
    });
    expect(upload.status).toBe(201);
    const asset = await upload.json();
    const update = editable(await (await f.request("settings")).json());
    update.bindings[0].enabled = false;
    expect((await (await f.apply("settings", update)).json()).applied).toBe(
      true,
    );
    const url = f.app.app.http!.url;
    expect(
      (
        await fetch(url + "/assets", {
          method: "POST",
          headers,
          body: "paused fixture bytes",
        })
      ).status,
    ).toBe(401);
    expect(
      (await fetch(url + "/assets/" + asset.asset_id, { headers })).status,
    ).toBe(401);
    expect((await fetch(url + "/mcp", { headers })).status).toBe(401);
  } finally {
    await f.close();
  }
});
