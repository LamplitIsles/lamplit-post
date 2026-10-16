import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { test, expect } from "vitest";
import {
  writeFile,
  readFile,
  readdir,
  mkdir,
  stat,
  access,
  copyFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { stateFixture, until } from "./fixtures/state";
import { platformsFixture } from "./fixtures/platforms";
import { processFixture } from "./fixtures/process";
import { Store } from "../src/store";
test("extracted Node artifact validates without writes, provisions, locks, crashes and reconciles without native resend", async () => {
  const p = await platformsFixture(),
    s = await stateFixture(p.url, "http://127.0.0.1:1");
  const artifactRoot = join(s.dir, "artifact");
  await mkdir(artifactRoot);
  execFileSync("tar", [
    "-xzf",
    resolve("dist/lamplit-post-node24.tar.gz"),
    "-C",
    artifactRoot,
  ]);
  const artifact = join(artifactRoot, "dist/cli.cjs"),
    plugin = join(artifactRoot, "dist/post-plugin.cjs");
  const home = join(s.dir, "home");
  await mkdir(home);
  const preload = join(s.dir, "network-preload.mjs");
  await copyFile(resolve("tests/fixtures/network-preload.mjs"), preload);
  const env = {
    ...process.env,
    NODE_OPTIONS: "--import=" + preload,
    POST_TEST_PLATFORM_ORIGIN: p.url,
    HOME: home,
    XDG_CONFIG_HOME: home,
    PATH: process.env.PATH,
  };
  const run = (args: string[], input?: string) =>
    processFixture([artifact, ...args], { cwd: s.dir, env, input }).exited;
  let serving: ReturnType<typeof processFixture> | undefined;
  let client: Client | undefined;
  const connect = async (url: string, token: string) => {
    const c = new Client({ name: "artifact-probe", version: "1" });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + token } },
      }),
    );
    return c;
  };
  try {
    const before = await readdir(s.dir);
    expect((await run(["--help"])).code).toBe(0);
    expect(await readdir(s.dir)).toEqual(before);
    const config = {
      ...s.config,
      data_dir: join(s.dir, "new-data"),
      accounts: s.config.accounts,
      bindings: s.config.bindings,
    };
    const path = join(s.dir, "koishi.yml");
    const write = (cfg: unknown) =>
      writeFile(
        path,
        stringify({
          daemon: { autoRestart: false },
          plugins: { [plugin]: cfg },
        }),
        { mode: 0o600 },
      );
    await write(config);
    const initial = await readFile(path);
    expect((await run(["config-check", "--config", path])).code).toBe(0);
    expect(await readFile(path)).toEqual(initial);
    await write({ ...config, data_dir: "${{ env.POST_DATA }}" });
    expect((await run(["config-check", "--config", path])).code).toBe(1);
    await write(config);
    await expect(access(config.data_dir)).rejects.toBeDefined();
    for (const args of [
      ["serve", "--config", path, "--typo", "yes"],
      ["credential-put", "--config", path],
      ["token-issue", "--config", path, "--agent", "missing"],
    ])
      expect((await run(args)).code).toBe(1);
    await expect(access(config.data_dir)).rejects.toBeDefined();
    await write({ ...config, typo: true });
    expect((await run(["serve", "--config", path])).code).toBe(1);
    await expect(access(config.data_dir)).rejects.toBeDefined();
    await write(config);
    expect(
      (
        await run(
          [
            "credential-put",
            "--config",
            path,
            "--ref",
            "matrix-secret",
            "--account",
            "matrix-main",
            "--kind",
            "platform",
          ],
          "secret-via-stdin\n",
        )
      ).code,
    ).toBe(0);
    expect(
      (
        await run(
          [
            "credential-put",
            "--config",
            path,
            "--ref",
            "receiver-secret",
            "--account",
            "cfl-binding",
            "--kind",
            "receiver",
          ],
          "receiver-via-stdin\n",
        )
      ).code,
    ).toBe(0);
    expect(
      (
        await run(
          [
            "credential-put",
            "--config",
            path,
            "--ref",
            "qq-secret",
            "--account",
            "qq-main",
            "--kind",
            "platform",
          ],
          "qq-via-stdin\n",
        )
      ).code,
    ).toBe(0);
    const issued = await run([
      "token-issue",
      "--config",
      path,
      "--agent",
      "cfl",
    ]);
    expect(issued.code).toBe(0);
    const token = issued.out.trim();
    expect(token).toHaveLength(43);
    await write({
      ...config,
      timeout_ms: 200,
      accounts: config.accounts.map((a) => ({
        ...a,
        native_id: a.platform === "matrix" ? "@wrong:fixture" : a.native_id,
      })),
    });
    const failedStart = await run(["serve", "--config", path]);
    expect(failedStart.code).toBe(1);
    await write(config);
    const store = await Store.open(config);
    expect(store.authenticate(token)).toBe("cfl");
    expect((await run(["status", "--config", path])).code).toBe(1);
    await store.close();
    serving = processFixture([artifact, "serve", "--config", path], {
      cwd: s.dir,
      env,
    });
    let ready = await serving.ready();
    expect((await run(["status", "--config", path])).code).toBe(1);
    client = await connect(ready.url, token);
    expect((await client.listTools()).tools).toHaveLength(7);
    const upload = await fetch(ready.url + "/assets", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/octet-stream",
      },
      body: "artifact bytes",
    });
    expect(upload.status).toBe(201);
    const asset = (await upload.json()) as any;
    expect(
      await (
        await fetch(ready.url + asset.download_path, {
          headers: { Authorization: "Bearer " + token },
        })
      ).text(),
    ).toBe("artifact bytes");
    p.stall();
    const args = {
      account_id: "matrix-main",
      conversation_id: "matrix-room",
      request_id: "actual-crash",
      content: [{ type: "text", text: "do not resend" }],
    };
    const pending = client
      .callTool({ name: "send_message", arguments: args })
      .catch((e) => e);
    await until(() => p.sendCount === 1);
    serving.kill("SIGKILL");
    const crashed = await serving.exited;
    expect(crashed.out + crashed.err).not.toContain("qq-via-stdin");
    expect(crashed.out + crashed.err).not.toContain("secret-via-stdin");
    expect(crashed.out + crashed.err).not.toContain(token);
    await pending;
    await client.close();
    client = undefined;
    await until(() => p.aborts === 1);
    p.stall(false);
    serving = processFixture([artifact, "serve", "--config", path], {
      cwd: s.dir,
      env,
    });
    ready = await serving.ready();
    client = await connect(ready.url, token);
    const result = await client.callTool({
      name: "send_message",
      arguments: args,
    });
    expect((result.structuredContent as any).status).toBe("unknown");
    expect(p.sendCount).toBe(1);
    expect(
      await (
        await fetch(ready.url + asset.download_path, {
          headers: { Authorization: "Bearer " + token },
        })
      ).text(),
    ).toBe("artifact bytes");
    await client.close();
    client = undefined;
    serving.kill("SIGTERM");
    const stopped = await serving.exited;
    expect(stopped.signal === "SIGTERM" || stopped.code === 0).toBe(true);
    serving = undefined;
    expect((await run(["status", "--config", path])).code).toBe(0);
    expect(
      (await run(["token-revoke", "--config", path, "--agent", "cfl"])).code,
    ).toBe(0);
    expect((await readFile(path, "utf8")).includes("secret-via-stdin")).toBe(
      false,
    );
    expect((await readFile(path, "utf8")).includes(token)).toBe(false);
    expect((await stat(config.data_dir)).mode & 0o077).toBe(0);
    const bytes = await readFile(join(config.data_dir, "post.sqlite"));
    expect(bytes.includes(Buffer.from("secret-via-stdin"))).toBe(false);
    expect(bytes.includes(Buffer.from(token))).toBe(false);
  } finally {
    await client?.close();
    serving?.kill("SIGKILL");
    if (serving) await serving.exited;
    await p.close();
    await s.close();
  }
}, 30000);

test("official CLI exits nonzero and releases ownership on provider startup rejection before database publication", async () => {
  const s = await stateFixture("http://127.0.0.1:1", "http://127.0.0.1:2");
  const artifact = join(s.dir, "start-failure-artifact");
  await mkdir(artifact);
  execFileSync("tar", [
    "-xzf",
    resolve("dist/lamplit-post-node24.tar.gz"),
    "-C",
    artifact,
  ]);
  const preload = join(s.dir, "reject-stamp.cjs"),
    config = join(s.dir, "start-failure.yml");
  await writeFile(
    preload,
    `const {DatabaseSync}=require('node:sqlite');const {writeSync}=require('node:fs');const original=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql,...args){if(sql.includes('PRAGMA application_id=1347375956')){writeSync(2,'OWNED_STAMP_REJECTION\\n');throw Error('owned stamping failure')}return original.call(this,sql,...args)};`,
  );
  const fresh = { ...s.config, data_dir: join(s.dir, "start-failure-state") };
  await writeFile(
    config,
    stringify({
      daemon: { autoRestart: false },
      plugins: { [join(artifact, "dist/post-plugin.cjs")]: fresh },
    }),
    { mode: 0o600 },
  );
  const child = processFixture(
    [join(artifact, "dist/cli.cjs"), "serve", "--config", config],
    {
      cwd: s.dir,
      env: {
        ...process.env,
        HOME: s.dir,
        XDG_CONFIG_HOME: s.dir,
        NODE_OPTIONS: "--require " + preload,
      },
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error("provider startup timeout")),
          5000,
        );
      }),
    ]);
    expect(result.err).toContain("OWNED_STAMP_REJECTION");
    expect(result.code).toBe(1);
    expect(result.out).not.toContain('"ready":true');
    await expect(
      access(join(fresh.data_dir, "owner.lock")),
    ).rejects.toBeDefined();
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    await child.exited;
    await s.close();
  }
});
