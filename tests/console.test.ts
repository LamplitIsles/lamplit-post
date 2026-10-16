import type {} from "@koishijs/plugin-console";
import { test, expect } from "vitest";
import { Context } from "@koishijs/core";
import { createRequire } from "node:module";
// Match the packaged Koishi loader's CommonJS resolution, including native exports.
const require = createRequire(import.meta.url);
const Server = require("@koishijs/plugin-server").default;
const Console = require("@koishijs/plugin-console").default;
const Status = require("@koishijs/plugin-status");
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { WebSocket } from "ws";
import { parse, stringify } from "yaml";
import { ConfigSchema } from "../src/config";
import { postPlugin, type Running } from "../src/runtime";
import { processFixture } from "./fixtures/process";
import { until } from "./fixtures/state";
import { httpFixture } from "./fixtures/http";

async function port() {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const value = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return value;
}
function channel(url: string) {
  const socket = new WebSocket(url);
  const messages: any[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  return { socket, messages };
}

test("one native root exposes only ping RPC and empty status, then closes UI/WS before releasing state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "post-console-root-"));
  const ctx = new Context();
  let running: Running | undefined;
  let socket: WebSocket | undefined;
  try {
    const ui = await port();
    ctx.plugin(Server, { host: "127.0.0.1", port: ui });
    ctx.plugin(Console, {
      devMode: false,
      uiPath: "",
      apiPath: "/status",
      selfUrl: "",
      open: false,
    });
    ctx.plugin(Status, {});
    const config = ConfigSchema({
      data_dir: join(dir, "data"),
      master_key_file: join(dir, "keys/post.key"),
      port: 0,
      accounts: [],
      bindings: [],
    });
    const ready = new Promise<Running>((resolve, reject) =>
      ctx.plugin(
        postPlugin({ connect: true, ready: resolve, failed: reject }),
        config,
      ),
    );
    await ctx.start();
    running = await ready;
    expect(running.context).toBe(ctx);
    expect(ctx.bots).toHaveLength(0);
    expect(running.host!.nativeBots.size).toBe(0);
    expect(Object.keys(ctx.console.listeners)).toEqual(["ping"]);
    expect(await running.service.status()).toMatchObject({
      healthy: true,
      accounts: [],
      backlog: [],
      errors: [],
    });
    const ws = channel(`ws://127.0.0.1:${ui}/status`);
    socket = ws.socket;
    await until(() =>
      ws.messages.some((m) => m.type === "data" && m.body.key === "status"),
    );
    expect(
      ws.messages.find((m) => m.body?.key === "status").body.value.bots,
    ).toEqual({});
    const closed = once(socket, "close");
    await running.stop();
    running = undefined;
    await closed;
    await expect(fetch(`http://127.0.0.1:${ui}/`)).rejects.toThrow();
    await expect(access(join(dir, "data/owner.lock"))).rejects.toThrow();
  } finally {
    socket?.terminate();
    await running?.stop();
    await ctx.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("canonical extracted managed app validates without state, serves native shell/assets and status data, and denies privileged RPC/MCP through restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "post-console-artifact-"));
  let child: ReturnType<typeof processFixture> | undefined;
  let socket: WebSocket | undefined;
  let phase = "materialize";
  let registry: Awaited<ReturnType<typeof httpFixture>> | undefined;
  try {
    const home = join(dir, "home"),
      root = join(home, "app"),
      configDir = root;
    await mkdir(root, { recursive: true });
    await mkdir(configDir, { mode: 0o700, recursive: true });
    execFileSync("tar", [
      "-xzf",
      resolve("dist/lamplit-post-node24.tar.gz"),
      "-C",
      root,
    ]);
    const template = await readFile(join(root, "koishi.yml"), "utf8");
    const document = parse(template);
    registry = await httpFixture(() =>
      Response.json({ objects: [], total: 0, version: 1, versions: {} }),
    );
    document.plugins.market.registry = {
      endpoint: `http://127.0.0.1:${registry.port}`,
      timeout: 100,
    };
    const post = "post",
      server = "server";
    expect(document.plugins[post].port).toBe(18787);
    expect(document.plugins[server].port).toBe(5140);
    const ui = await port(),
      api = await port();
    document.plugins[server].port = ui;
    document.plugins[post].port = api;
    const config = join(configDir, "koishi.yml"),
      cli = join(root, "dist/cli.cjs");
    const env = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: home,
      NODE_OPTIONS: "",
    };
    const write = () => writeFile(config, stringify(document), { mode: 0o600 });
    await write();
    const initial = await readFile(config);
    const run = async (args: string[]) => {
      const process = processFixture([cli, ...args], { cwd: configDir, env });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          process.exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  Error(
                    `CLI ${args.join(" ")} did not finish; stdout=${process.out}; stderr=${process.err}`,
                  ),
                ),
              5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
        process.kill("SIGKILL");
        await process.exited;
      }
    };
    expect((await run(["--help"])).code).toBe(0);
    expect((await run(["config-check", "--config", config])).code).toBe(0);
    expect(await readFile(config)).toEqual(initial);
    await expect(access(join(configDir, "data"))).rejects.toThrow();
    for (const mutate of [
      () => {
        document.plugins[server].host = "0.0.0.0";
      },
      () => {
        document.plugins[server].port = api;
      },
      () => {
        document.plugins.auth.admin.enabled = true;
      },
    ]) {
      const previous = stringify(document);
      mutate();
      await write();
      expect((await run(["config-check", "--config", config])).code).toBe(1);
      Object.keys(document).forEach((k) => delete document[k]);
      Object.assign(document, parse(previous));
    }
    await write();
    const start = async () => {
      child = processFixture([cli, "serve", "--config", config], {
        cwd: configDir,
        env,
      });
      const ready = await child.ready();
      expect(ready.status).toEqual({
        healthy: true,
        accounts: [],
        backlog: [],
        errors: [],
      });
      return ready;
    };
    phase = "first startup";
    await start();
    phase = "HTTP assets";
    const base = `http://127.0.0.1:${ui}`;
    const html = await (await fetch(base + "/")).text();
    expect(html).toContain("<title>Koishi");
    expect(html).toContain('"endpoint":"/status"');
    for (const [, path] of html.matchAll(/(?:src|href)="(\/[^"#]+)"/g)) {
      const response = await fetch(base + path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type"), path).not.toContain(
        "text/html",
      );
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }
    const ws = channel(`ws://127.0.0.1:${ui}/status`);
    socket = ws.socket;
    await until(
      () =>
        ws.messages.some((m) => m.body?.key === "status") &&
        ws.messages.some((m) => m.body?.key === "entry" && m.body.value),
    );
    expect(
      ws.messages.find((m) => m.body?.key === "status").body.value,
    ).toBeNull();
    const entry = ws.messages.find((m) => m.body?.key === "entry").body.value;
    for (const { files } of Object.values(entry).filter(
      (v) => typeof v === "object",
    ) as any[]) {
      for (const path of files) {
        const response = await fetch(base + path);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).not.toContain("text/html");
      }
    }
    const call = async (type: string) => {
      socket!.send(JSON.stringify({ type, args: [], id: type }));
      await until(() =>
        ws.messages.some((m) => m.type === "response" && m.body.id === type),
      );
      return ws.messages.find(
        (m) => m.type === "response" && m.body.id === type,
      ).body;
    };
    expect((await call("ping")).value).toBe("pong");
    for (const rpc of [
      "manager/reload",
      "manager/unload",
      "config",
      "market/install",
      "sandbox/send",
      "post/token-issue",
      "console/listeners",
      "eval",
    ]) {
      expect((await call(rpc)).error).toBe(
        ["manager/reload", "manager/unload", "market/install"].includes(rpc)
          ? "unauthorized"
          : "not implemented",
      );
    }
    for (const path of ["/mcp", "/assets/missing"])
      expect((await fetch(`http://127.0.0.1:${api}${path}`)).status).toBe(401);
    phase = "MCP denial";
    const client = new Client({
      name: "unauthenticated-app-denied",
      version: "1",
    });
    try {
      await expect(
        client.connect(
          new StreamableHTTPClientTransport(
            new URL(`http://127.0.0.1:${api}/mcp`),
          ),
        ),
      ).rejects.toThrow();
    } finally {
      await client.close();
    }
    const closed = once(socket, "close");
    child!.kill("SIGTERM");
    await child!.exited;
    child = undefined;
    await closed;
    for (const origin of [base, `http://127.0.0.1:${api}`])
      await expect(fetch(origin)).rejects.toThrow();
    await expect(access(join(configDir, "data/owner.lock"))).rejects.toThrow();
    phase = "offline status";
    const status = await run(["status", "--config", config]);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.out)).toMatchObject({ accounts: [], gaps: [] });
    expect(
      JSON.parse(status.out).deliveries.every((d: any) => d.count === 0),
    ).toBe(true);
    await start();
    child!.kill("SIGTERM");
    const stopped = await child!.exited;
    child = undefined;
    expect(stopped.out + stopped.err).not.toMatch(
      /post_[A-Za-z0-9_-]{40}|BEGIN PRIVATE/,
    );
    // A native UI port-probe failure must not publish readiness or retain ownership.
    phase = "occupied UI failure";
    const occupied = createServer();
    occupied.listen(ui, "127.0.0.1");
    await once(occupied, "listening");
    try {
      const failed = await run(["serve", "--config", config]);
      expect(failed.code).toBe(1);
      expect(failed.out).not.toContain('"ready":true');
      await expect(
        access(join(configDir, "data/owner.lock")),
      ).rejects.toThrow();
    } finally {
      await new Promise<void>((r) => occupied.close(() => r()));
    }
  } catch (error) {
    throw new Error(
      `Managed app phase ${phase}: ${String(error)}; stdout=${child?.out ?? ""}; stderr=${child?.err ?? ""}`,
      { cause: error },
    );
  } finally {
    socket?.terminate();
    child?.kill("SIGKILL");
    if (child) await child.exited;
    await registry?.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
