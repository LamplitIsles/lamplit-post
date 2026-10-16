import { test, expect } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { parse, stringify } from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { platformsFixture } from "./fixtures/platforms";
import { stateFixture, until } from "./fixtures/state";
import { httpFixture } from "./fixtures/http";
import { processFixture } from "./fixtures/process";
import { rpc } from "./fixtures/console";
async function free() {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as any).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test("native Auth fails closed before ready and after expiry/logout; Config drains durable sends and preserves queued snapshots", async () => {
  const p = await platformsFixture();
  const attempts: string[] = [];
  let accepting = false;
  const receiver = await httpFixture(async (req) => {
    attempts.push(await req.text());
    return new Response(null, { status: accepting ? 204 : 503 });
  });
  const receiverURL = `http://127.0.0.1:${receiver.port}`;
  const state = await stateFixture(p.url, receiverURL);
  const root = await mkdtemp(join(tmpdir(), "post-managed-config-")),
    app = join(root, "app"),
    home = join(root, "home");
  await mkdir(app, { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  execFileSync("tar", [
    "-xzf",
    resolve("dist/lamplit-post-node24.tar.gz"),
    "-C",
    app,
  ]);
  const preload = join(root, "network.mjs");
  await writeFile(
    preload,
    (await readFile("tests/fixtures/network-preload.mjs", "utf8")).replace(
      "if (url.origin !== origin)",
      "if (url.origin !== origin && url.origin !== process.env.POST_TEST_RECEIVER_ORIGIN)",
    ),
  );
  const pnpm = process.env.POST_TEST_PNPM ?? process.env.npm_execpath!;
  const env = {
    ...process.env,
    HOME: home,
    PNPM_HOME: join(home, "pnpm"),
    XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: home,
    npm_config_userconfig: join(home, ".npmrc"),
    COREPACK_ENABLE_NETWORK: "0",
    PATH: dirname(pnpm) + ":" + process.env.PATH,
    NODE_OPTIONS: "--import=" + preload,
    POST_TEST_PLATFORM_ORIGIN: p.url,
    POST_TEST_RECEIVER_ORIGIN: receiverURL,
  };
  const ui = await free(),
    api = await free(),
    path = join(app, "koishi.yml");
  const document = parse(await readFile(path, "utf8"));
  document.plugins.post = { ...state.config, port: api };
  document.plugins.server.port = ui;
  document.plugins.market.registry = { endpoint: p.url, timeout: 100 };
  // A test-owned ordinary plugin delays the REAL native Auth.start and exposes
  // fixture-only setup hooks. No alternate identity/provider is created.
  const gate = join(app, "auth-gate.cjs");
  await writeFile(
    gate,
    `const {createHash}=require('node:crypto');exports.name='owned-auth-gate';exports.apply=ctx=>{const Auth=require('@koishijs/plugin-auth').default;const start=Auth.prototype.start;let release;const wait=new Promise(r=>release=r);Auth.prototype.start=async function(){await wait;return start.call(this)};ctx.inject(['server'],c=>{c.server.get('/owned/auth-state',r=>r.body={ready:!!ctx.get('auth')});c.server.post('/owned/release-auth',r=>{release();r.body={released:true}})});ctx.inject(['auth'],c=>{c.console.addListener('owned/low-user',()=>c.database.create('user',{name:'low',authority:1,password:createHash('sha256').update('synthetic-low-password').digest('hex'),createdAt:new Date()}),{authority:4});c.console.addListener('owned/expire',async function(){await c.database.set('token',{token:this.auth.token},{expiredAt:Date.now()-1});this.auth.expiredAt=Date.now()-1},{authority:4});});ctx.on('dispose',release);};`,
  );
  document.plugins = { [gate]: {}, ...document.plugins };
  await writeFile(path, stringify(document), { mode: 0o600 });
  const secretPath = join(root, "owner");
  const provision = await processFixture(
    [
      join(app, "dist/cli.cjs"),
      "admin-provision",
      "--config",
      path,
      "--file",
      secretPath,
    ],
    { cwd: app, env },
  ).exited;
  expect(provision.code).toBe(0);
  const password = (await readFile(secretPath, "utf8")).match(
    /Password: (.*)/,
  )![1];
  let child: ReturnType<typeof processFixture> | undefined,
    consoleClient: Awaited<ReturnType<typeof rpc>> | undefined,
    mcp: Client | undefined;
  const apiURL = `http://127.0.0.1:${api}`,
    uiURL = `http://127.0.0.1:${ui}`;
  const release = () =>
    fetch(uiURL + "/owned/release-auth", { method: "POST" });
  const connectConsole = async () => {
    await until(async () => {
      try {
        consoleClient = await rpc(uiURL.replace("http", "ws") + "/status");
        return true;
      } catch {
        return false;
      }
    }, 10000);
    return consoleClient!;
  };
  const login = async () => {
    const c = await connectConsole();
    expect(
      (await c.call("login/password", "admin", password)).error,
    ).toBeUndefined();
    await until(() => c.data.get("config")?.plugins);
    return c;
  };
  const connectMCP = async () => {
    const client = new Client({ name: "managed-config", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(apiURL + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + state.token } },
      }),
    );
    mcp = client;
    return client;
  };
  try {
    child = processFixture(["run", "start"], {
      executable: pnpm,
      cwd: app,
      env,
    });
    const c = await connectConsole();
    expect(await (await fetch(uiURL + "/owned/auth-state")).json()).toEqual({
      ready: false,
    });
    expect((await c.call("manager/app-reload", {})).error).toBe("unauthorized");
    expect((await c.call("market/install", {})).error).toBe("unauthorized");
    expect(c.data.get("config")).toBeFalsy();
    expect(c.data.get("logs")).toBeFalsy();
    await release();
    await child.ready();
    expect(
      (await c.call("login/password", "admin", password)).error,
    ).toBeUndefined();
    await until(() => c.data.get("config")?.plugins);
    const user = c.data.get("user");
    expect(
      (
        await fetch(apiURL + "/assets/missing", {
          headers: { Authorization: "Bearer " + user.token },
        })
      ).status,
    ).toBe(401);
    expect((await c.call("owned/low-user")).error).toBeUndefined();
    const low = await rpc(uiURL.replace("http", "ws") + "/status");
    try {
      expect(
        (await low.call("login/password", "low", "synthetic-low-password"))
          .error,
      ).toBeUndefined();
      expect((await low.call("manager/app-reload", {})).error).toBe(
        "unauthorized",
      );
      expect(
        (await low.call("user/update", { authority: 5 })).error,
      ).toBeDefined();
      expect(low.data.get("analytics")).toBeFalsy();
      expect(low.data.get("logs")).toBeFalsy();
    } finally {
      low.socket.terminate();
    }
    expect((await c.call("owned/expire")).error).toBeUndefined();
    expect((await c.call("manager/app-reload", {})).error).toBe("unauthorized");
    expect(
      (await c.call("login/password", "admin", password)).error,
    ).toBeUndefined();
    await until(() => c.data.get("config")?.plugins);
    const config = c.data.get("config"),
      postKey = Object.keys(config.plugins).find(
        (k) => k.split(":")[0] === "post",
      )!;
    const unchanged = await readFile(path);
    const invalid = structuredClone(config.plugins[postKey]);
    invalid.bindings[0].scopes[0].account_id = "missing";
    expect(
      (await c.call("manager/reload", "", postKey, invalid)).error,
    ).toBeDefined();
    expect(await readFile(path)).toEqual(unchanged);
    p.sendQQ(
      "GROUP_AT_MESSAGE_CREATE",
      "immutable snapshot before settings change",
    );
    await until(() => attempts.length > 0);
    const snapshot = attempts[0];
    const client = await connectMCP();
    p.stall();
    const args = {
      account_id: "matrix-main",
      conversation_id: "matrix-room",
      request_id: "config-inflight",
      content: [{ type: "text", text: "native handoff before restart" }],
    };
    let sendOutcome: unknown;
    const send = client
      .callTool({ name: "send_message", arguments: args })
      .then((result) => {
        sendOutcome = result;
        return result;
      })
      .catch((error) => {
        sendOutcome = { error: error.message };
        return undefined;
      });
    try {
      await until(() => p.sendCount > 0);
    } catch (error) {
      console.error(
        "Owned Matrix handoff diagnostic",
        JSON.stringify({
          sendOutcome,
          sends: p.sendCount,
          paths: p.calls.map((call) => call.path),
          status: await (await fetch(apiURL + "/healthz")).json(),
        }),
      );
      throw error;
    }
    const nativeCount = p.sendCount;
    const valid = structuredClone(config.plugins[postKey]);
    valid.bindings[0].wake.aliases = ["Updated,"];
    const oldOwner = JSON.parse(
      await readFile(join(state.config.data_dir, "owner.lock"), "utf8"),
    ).pid;
    const saved = await c.call("manager/reload", "", postKey, valid);
    expect(saved.error).toBeUndefined();
    await send;
    await mcp!.close();
    mcp = undefined;
    c.socket.terminate();
    await until(async () => {
      try {
        return (
          JSON.parse(
            await readFile(join(state.config.data_dir, "owner.lock"), "utf8"),
          ).pid !== oldOwner &&
          (await fetch(uiURL + "/owned/auth-state")).status === 200
        );
      } catch {
        return false;
      }
    }, 10000);
    await release();
    const restarted = await login();
    const current = restarted.data.get("config");
    expect(current.plugins[postKey].bindings[0].wake.aliases).toEqual([
      "Updated,",
    ]);
    p.stall(false);
    accepting = true;
    await until(
      () => attempts.filter((body) => body === snapshot).length > 1,
      10000,
    );
    expect(
      attempts
        .filter(
          (body) =>
            JSON.parse(body).delivery_id === JSON.parse(snapshot).delivery_id,
        )
        .every((body) => body === snapshot),
    ).toBe(true);
    const after = await connectMCP();
    const result = await after.callTool({
      name: "send_message",
      arguments: args,
    });
    expect((result.structuredContent as any).status).toBe("unknown");
    expect(p.sendCount).toBe(nativeCount);
    p.sendMatrix({ msgtype: "m.text", body: "Post, obsolete alias" });
    await until(async () => {
      const history = await after.callTool({
        name: "read_messages",
        arguments: {
          account_id: "matrix-main",
          conversation_id: "matrix-room",
        },
      });
      return JSON.stringify(history.structuredContent).includes(
        "obsolete alias",
      );
    });
    expect(attempts.some((body) => body.includes("obsolete alias"))).toBe(
      false,
    );
    p.sendMatrix({ msgtype: "m.text", body: "Updated, active alias" });
    await until(() => attempts.some((body) => body.includes("active alias")));
    expect(
      JSON.parse(attempts.find((body) => body.includes("active alias"))!).wake
        .reason,
    ).toBe("alias_matched");
    const logoutUser = restarted.data.get("user");
    expect((await restarted.call("user/logout")).error).toBeUndefined();
    expect(
      (await restarted.call("login/token", logoutUser.id, logoutUser.token))
        .error,
    ).toBeDefined();
    expect((await restarted.call("manager/app-reload", {})).error).toBe(
      "unauthorized",
    );
    expect(
      (await restarted.call("login/password", "admin", password)).error,
    ).toBeUndefined();
    await until(() => restarted.data.get("config")?.plugins);
    const authKey = Object.keys(restarted.data.get("config").plugins).find(
      (key) => key.split(":")[0] === "auth",
    )!;
    expect(
      (
        await restarted.call("manager/unload", "", authKey, {
          admin: { enabled: false },
        })
      ).error,
    ).toBeUndefined();
    expect((await restarted.call("manager/app-reload", {})).error).toBe(
      "unauthorized",
    );
    expect((await fetch(uiURL + "/owned/auth-state")).ok).toBe(true);
    expect(await (await fetch(uiURL + "/owned/auth-state")).json()).toEqual({
      ready: false,
    });
    expect(child.out + child.err).not.toContain(password);
  } catch (error) {
    console.error("Owned native config output", child?.out, child?.err);
    throw error;
  } finally {
    consoleClient?.socket.terminate();
    await mcp?.close();
    child?.kill("SIGTERM");
    if (child) await child.exited;
    await p.close();
    await receiver.stop();
    await state.close();
    await rm(root, { recursive: true, force: true });
  }
}, 45000);

test("native group/meta edits validate before writes and preserve immutable pins and ordinary lifecycle", async () => {
  const p = await platformsFixture();
  const state = await stateFixture(p.url, p.url);
  const root = await mkdtemp(join(tmpdir(), "post-edit-guards-")),
    app = join(root, "app"),
    home = join(root, "home");
  await mkdir(app, { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  execFileSync("tar", [
    "-xzf",
    resolve("dist/lamplit-post-node24.tar.gz"),
    "-C",
    app,
  ]);
  const preload = join(root, "network.mjs"),
    errors = join(root, "unhandled");
  await writeFile(
    preload,
    (await readFile("tests/fixtures/network-preload.mjs", "utf8")) +
      `\nimport {appendFileSync} from 'node:fs';process.on('unhandledRejection',e=>appendFileSync(${JSON.stringify(errors)},String(e?.message)+'\\n'));`,
  );
  const ordinary = join(app, "owned-ordinary.cjs");
  await writeFile(
    ordinary,
    `const {Schema}=require('koishi');exports.name='owned-ordinary';exports.Config=Schema.object({value:Schema.string().default('original')});exports.apply=(ctx,cfg)=>{ctx.inject(['server'],c=>c.server.get('/owned/ordinary',r=>r.body={value:cfg.value,pid:process.pid}));ctx.inject(['database','console'],c=>c.console.addListener('owned/pins',async()=>({pid:process.pid,identities:await c.database.get('post_identities',{}),conversations:await c.database.get('post_conversations',{})}),{authority:4}));};`,
  );
  const ui = await free(),
    api = await free(),
    path = join(app, "koishi.yml");
  const document = parse(await readFile(path, "utf8"));
  const group = "group:managed",
    post = "post:owner",
    auth = "auth:human";
  document.plugins[group] = {
    [post]: { ...state.config, port: api },
    [auth]: document.plugins.auth,
    "logger:safe": document.plugins.logger,
  };
  delete document.plugins.post;
  delete document.plugins.auth;
  delete document.plugins.logger;
  document.plugins["group:ordinary"] = { [ordinary + ":probe"]: {} };
  document.plugins.server.port = ui;
  document.plugins[group].server = document.plugins.server;
  delete document.plugins.server;
  document.plugins.market.registry = { endpoint: p.url, timeout: 100 };
  await writeFile(path, stringify(document), { mode: 0o600 });
  const pnpm = process.env.POST_TEST_PNPM ?? process.env.npm_execpath!;
  const env = {
    ...process.env,
    HOME: home,
    PNPM_HOME: join(home, "pnpm"),
    XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: home,
    COREPACK_ENABLE_NETWORK: "0",
    PATH: dirname(pnpm) + ":" + process.env.PATH,
    NODE_OPTIONS: "--import=" + preload,
    POST_TEST_PLATFORM_ORIGIN: p.url,
  };
  const secretPath = join(root, "owner");
  expect(
    (
      await processFixture(["run", "admin-provision", "--file", secretPath], {
        executable: pnpm,
        cwd: app,
        env,
      }).exited
    ).code,
  ).toBe(0);
  const password = (await readFile(secretPath, "utf8")).match(
    /Password: (.*)/,
  )![1];
  let child: ReturnType<typeof processFixture> | undefined,
    c: Awaited<ReturnType<typeof rpc>> | undefined;
  let base = `http://127.0.0.1:${ui}`;
  const login = async () => {
    await until(async () => {
      try {
        c = await rpc(base.replace("http", "ws") + "/status");
        return true;
      } catch {
        return false;
      }
    }, 10000);
    expect(
      (await c!.call("login/password", "admin", password)).error,
    ).toBeUndefined();
    await until(() => c!.data.get("config")?.plugins);
    return c!;
  };
  const owner = () =>
    readFile(join(state.config.data_dir, "owner.lock"), "utf8").then(
      JSON.parse,
    );
  try {
    child = processFixture(["run", "start"], {
      executable: pnpm,
      cwd: app,
      env,
    });
    await child.ready();
    await login();
    const initialOwner = await owner(),
      pins = (await c!.call("owned/pins")).value;
    expect(pins.identities).toHaveLength(2);
    expect(pins.conversations).toHaveLength(4);
    const current = c!.data.get("config").plugins[group];
    const unchanged = async (action: () => Promise<any>) => {
      const yaml = await readFile(path),
        before = await owner();
      expect((await action()).error).toBeDefined();
      expect(await readFile(path)).toEqual(yaml);
      expect(await owner()).toEqual(before);
      expect((await c!.call("owned/pins")).value).toEqual(pins);
    };
    const invalid = structuredClone(current);
    invalid[post].bindings[0].scopes[0].account_id = "missing";
    await unchanged(() => c!.call("manager/reload", "", group, invalid));
    const forbidden = structuredClone(current);
    forbidden[auth].admin = {
      enabled: true,
      password: "OWNED_FORBIDDEN_INITIAL_PASSWORD",
    };
    await unchanged(() => c!.call("manager/reload", "", group, forbidden));
    for (const fields of [
      { backlog_limit: 0 },
      { bindings: invalid[post].bindings },
      { $label: 42 },
    ])
      await unchanged(() => c!.call("manager/meta", "owner", fields));
    for (const mutate of [
      (cfg: any) =>
        (cfg.bindings[0].scopes[0].conversation_id = "qq-group-renamed"),
      (cfg: any) => (cfg.bindings[0].scopes[0].native_id = "changed-native"),
      (cfg: any) => (cfg.bindings[0].scopes[0].type = "direct"),
      (cfg: any) => (cfg.bindings[0].scopes[0].account_id = "matrix-main"),
      (cfg: any) => (cfg.accounts[0].native_id = "changed-identity"),
    ]) {
      const next = structuredClone(current);
      mutate(next[post]);
      await unchanged(() =>
        c!.call("manager/reload", "managed", post, next[post]),
      );
      await unchanged(() => c!.call("manager/reload", "", group, next));
    }
    expect(
      (await c!.call("manager/meta", "owner", { $label: "Owned Post label" }))
        .error,
    ).toBeUndefined();
    expect(
      (await c!.call("manager/meta", "managed", { $collapsed: true })).error,
    ).toBeUndefined();
    expect(await owner()).toEqual(initialOwner);
    expect(
      (
        await processFixture(["run", "config-check"], {
          executable: pnpm,
          cwd: app,
          env,
        }).exited
      ).code,
    ).toBe(0);
    const ordinaryKey = ordinary + ":probe";
    expect(
      (
        await c!.call("manager/reload", "", "group:ordinary", {
          [ordinaryKey]: { value: "updated" },
        })
      ).error,
    ).toBeUndefined();
    await until(
      async () =>
        (await (await fetch(base + "/owned/ordinary")).json()).value ===
        "updated",
    );
    expect(await owner()).toEqual(initialOwner);
    expect(
      (
        await c!.call("manager/unload", "ordinary", ordinaryKey, {
          value: "disabled",
        })
      ).error,
    ).toBeUndefined();
    await until(
      async () =>
        !(await fetch(base + "/owned/ordinary")).headers
          .get("content-type")
          ?.includes("application/json"),
    );
    expect(
      (
        await c!.call("manager/reload", "ordinary", ordinaryKey, {
          value: "enabled",
        })
      ).error,
    ).toBeUndefined();
    await until(
      async () =>
        (await (await fetch(base + "/owned/ordinary")).json()).value ===
        "enabled",
    );
    const valid = structuredClone(c!.data.get("config").plugins[group]);
    valid[post].bindings[0].wake.aliases = ["Safe,"];
    valid[post].backlog_limit = 9999;
    // Both listeners may change together in one valid native group edit.
    valid[post].port = ui;
    valid[Object.keys(valid).find((key) => key.startsWith("server:"))!].port =
      api;
    expect(
      (await c!.call("manager/reload", "", group, valid)).error,
    ).toBeUndefined();
    c!.socket.terminate();
    c = undefined;
    base = `http://127.0.0.1:${api}`;
    await until(async () => {
      try {
        return (
          (await owner()).pid !== initialOwner.pid &&
          (await fetch(base + "/owned/ordinary")).ok
        );
      } catch {
        return false;
      }
    }, 10000);
    await login();
    const saved = c!.data.get("config").plugins[group];
    expect(saved[post].backlog_limit).toBe(9999);
    expect(saved[post].bindings[0].wake.aliases).toEqual(["Safe,"]);
    expect(saved[post].$label).toBe("Owned Post label");
    const after = (await c!.call("owned/pins")).value;
    expect(after.identities).toEqual(pins.identities);
    expect(after.conversations).toEqual(pins.conversations);
    expect(await readFile(path, "utf8")).not.toContain(
      "OWNED_FORBIDDEN_INITIAL_PASSWORD",
    );
    c!.socket.terminate();
    c = undefined;
    child.kill("SIGTERM");
    await child.exited;
    child = undefined;
    expect(await readFile(errors, "utf8").catch(() => "")).toBe("");
  } finally {
    c?.socket.terminate();
    child?.kill("SIGTERM");
    if (child) await child.exited;
    await p.close();
    await state.close();
    await rm(root, { recursive: true, force: true });
  }
}, 45000);
