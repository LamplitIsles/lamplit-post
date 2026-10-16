import type {} from "@koishijs/plugin-analytics";
import { test, expect } from "vitest";
import { Context, Logger } from "@koishijs/core";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { postPlugin, type Running } from "../src/runtime";
import { Ownership } from "../src/ownership";
import { safeLog } from "../src/logging";
import { stateFixture, until } from "./fixtures/state";
import { platformsFixture } from "./fixtures/platforms";
const require = createRequire(import.meta.url);
const Server = require("@koishijs/plugin-server").default;
const Console = require("@koishijs/plugin-console").default;
const Analytics = require("@koishijs/plugin-analytics").default;
const NativeLogger = require("@koishijs/plugin-logger");

test("native Analytics counts QQ and Matrix events once; safe Logger drains before data ownership release", async () => {
  const p = await platformsFixture(),
    s = await stateFixture(p.url, "http://127.0.0.1:1");
  const net = createServer();
  net.listen(0, "127.0.0.1");
  await once(net, "listening");
  const port = (net.address() as any).port;
  await new Promise<void>((r) => net.close(() => r()));
  const ctx = new Context();
  ctx.baseDir = s.dir;
  ctx.plugin(Server, { host: "127.0.0.1", port });
  ctx.plugin(Console, {
    uiPath: "",
    apiPath: "/status",
    selfUrl: "",
    open: false,
    devMode: false,
  });
  let running: Running | undefined;
  const nativeClose = Ownership.prototype.close;
  let released = false;
  Ownership.prototype.close = function () {
    if (this.config.data_dir === s.config.data_dir) {
      // Actual OS handles, not framework disposal completion.
      const fs = require("node:fs");
      const openLogs = fs
        .readdirSync("/proc/self/fd")
        .flatMap((fd: string) => {
          try {
            return [fs.readlinkSync("/proc/self/fd/" + fd)];
          } catch {
            return [];
          }
        })
        .filter((path: string) => path.startsWith(join(s.dir, "logs")));
      expect(openLogs).toEqual([]);
      released = true;
    }
    return nativeClose.call(this);
  };
  try {
    const ready = new Promise<Running>((resolve, reject) =>
      ctx.plugin(
        postPlugin({
          connect: true,
          fixture: { qqOrigin: p.url, qqGateway: p.gateway },
          ready: resolve,
          failed: reject,
        }),
        s.config,
      ),
    );
    ctx.plugin(Analytics, { statsInternal: 600000 });
    ctx.plugin(NativeLogger, { root: "logs", maxSize: 512, maxAge: 30 });
    await ctx.start();
    running = await ready;
    const analytics = ctx.console.services.analytics;
    const db = running.store.db as unknown as Context["database"];
    await analytics.upload(true);
    const totals = async () => {
      const rows = await db.get("analytics.message", {});
      return Object.fromEntries(
        ["qq:send", "qq:receive", "matrix:send", "matrix:receive"].map(
          (key) => [
            key,
            rows
              .filter((r) => r.platform + ":" + r.type === key)
              .reduce((sum, row) => sum + row.count, 0),
          ],
        ),
      );
    };
    const before = await totals();
    p.sendQQ("GROUP_AT_MESSAGE_CREATE", "native analytics inbound");
    p.sendMatrix({ msgtype: "m.text", body: "native analytics inbound" });
    await until(async () => {
      await analytics.upload(true);
      const now = await totals();
      return (
        now["qq:receive"] === before["qq:receive"] + 1 &&
        now["matrix:receive"] === before["matrix:receive"] + 1
      );
    });
    for (const [account, conversation] of [
      ["qq-main", "qq-group"],
      ["matrix-main", "matrix-room"],
    ]) {
      const result = await running.service.send(
        "cfl",
        {
          account_id: account,
          conversation_id: conversation,
          request_id: "analytics-" + account,
          content: [{ type: "text", text: "confirmed" }],
        },
        running.service.signal(),
      );
      expect(result.status).toBe("sent");
    }
    await analytics.upload(true);
    let now = await totals();
    expect(now["qq:send"] - before["qq:send"]).toBe(1);
    expect(now["matrix:send"] - before["matrix:send"]).toBe(1);
    p.failAt(p.sendCount + 1, 403);
    expect(
      (
        await running.service.send(
          "cfl",
          {
            account_id: "matrix-main",
            conversation_id: "matrix-room",
            request_id: "analytics-failed",
            content: [{ type: "text", text: "failed" }],
          },
          running.service.signal(),
        )
      ).status,
    ).toBe("failed");
    await analytics.upload(true);
    expect((await totals())["matrix:send"]).toBe(now["matrix:send"]);
    new Logger("qq").error(new Error("SYNTHETIC_SECRET TRANSPORT_BODY"));
    safeLog("application_ready");
    for (let i = 0; i < 20; i++) {
      safeLog("configuration_restart");
      await new Promise<void>((r) => setImmediate(r));
    }
    await running.stop();
    running = undefined;
    expect(released).toBe(true);
    const text = (
      await Promise.all(
        (await readdir(join(s.dir, "logs"))).map((f) =>
          readFile(join(s.dir, "logs", f), "utf8"),
        ),
      )
    ).join("");
    expect(text).not.toContain("SYNTHETIC_SECRET");
    expect(text).not.toContain("TRANSPORT_BODY");
    expect(text).toContain("application_ready");
  } finally {
    await running?.stop();
    Ownership.prototype.close = nativeClose;
    await ctx.stop();
    await p.close();
    await s.close();
  }
});

test("native Logger close waits for initialization I/O before resolving", async () => {
  const fs = require("node:fs/promises");
  const dir = await fs.mkdtemp(
    join(require("node:os").tmpdir(), "post-log-init-"),
  );
  const ctx = new Context();
  ctx.baseDir = dir;
  const logRoot = join(dir, "logs");
  const mkdir = fs.mkdir;
  let release!: () => void,
    entered = false;
  const held = new Promise<void>((resolve) => (release = resolve));
  fs.mkdir = async function (path: string, ...args: any[]) {
    if (path === logRoot) {
      entered = true;
      await held;
    }
    return mkdir.call(this, path, ...args);
  };
  let start: Promise<void> | undefined;
  try {
    ctx.plugin(Server, { host: "127.0.0.1", port: 0 });
    ctx.plugin(Console, {
      uiPath: "",
      apiPath: "/status",
      selfUrl: "",
      open: false,
      devMode: false,
    });
    ctx.plugin(NativeLogger, { root: "logs", maxAge: 30, maxSize: 102400 });
    start = ctx.start();
    await until(() => entered);
    let closed = false;
    const closing = ctx.parallel("logger/close").then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    release();
    await closing;
    await start;
    expect(closed).toBe(true);
    const fds = await readdir("/proc/self/fd");
    const open = await Promise.all(
      fds.map((fd) => fs.readlink("/proc/self/fd/" + fd).catch(() => "")),
    );
    expect(open.filter((path: string) => path.startsWith(logRoot))).toEqual([]);
  } finally {
    fs.mkdir = mkdir;
    release();
    await start?.catch(() => {});
    await ctx.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("native Logger close seals a deferred initial flush before closing its handle", async () => {
  const fs = require("node:fs/promises");
  const dir = await fs.mkdtemp(
    join(require("node:os").tmpdir(), "post-log-flush-"),
  );
  const ctx = new Context();
  ctx.baseDir = dir;
  const open = fs.open;
  let entered = false,
    release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  fs.open = async function (path: string, ...args: any[]) {
    if (path.startsWith(join(dir, "logs"))) {
      entered = true;
      await held;
    }
    return open.call(this, path, ...args);
  };
  let start: Promise<void> | undefined;
  try {
    ctx.plugin(Server, { host: "127.0.0.1", port: 0 });
    ctx.plugin(Console, {
      uiPath: "",
      apiPath: "/status",
      selfUrl: "",
      open: false,
      devMode: false,
    });
    ctx.plugin(NativeLogger, { root: "logs", maxAge: 30, maxSize: 102400 });
    start = ctx.start();
    await until(() => entered);
    safeLog("application_ready");
    safeLog("configuration_restart");
    let closed = false;
    const closing = ctx.parallel("logger/close").then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    release();
    await closing;
    await start;
    const logs = (
      await Promise.all(
        (await fs.readdir(join(dir, "logs"))).map((name: string) =>
          fs.readFile(join(dir, "logs", name), "utf8"),
        ),
      )
    ).join("");
    expect(logs).toContain("application_ready");
    expect(logs).toContain("configuration_restart");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const paths = await Promise.all(
      (await fs.readdir("/proc/self/fd")).map((fd: string) =>
        fs.readlink("/proc/self/fd/" + fd).catch(() => ""),
      ),
    );
    expect(
      paths.filter((path: string) => path.startsWith(join(dir, "logs"))),
    ).toEqual([]);
  } finally {
    fs.open = open;
    release();
    await start?.catch(() => {});
    await ctx.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
