import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { test, expect } from "bun:test";
import { writeFile, readFile, readdir, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "@iarna/toml";
import { stateFixture, until } from "./fixtures/state";
import { platformsFixture } from "./fixtures/platforms";
import { Store } from "../src/store";
test("built artifact CLI validates without state, provisions offline, locks, serves and stops in isolated HOME", async () => {
  const p = await platformsFixture(),
    s = await stateFixture(p.url, "http://127.0.0.1:1");
  const artifact = join(s.dir, "post.js");
  const env = { ...process.env, HOME: join(s.dir, "home") };
  await mkdir(env.HOME);
  const run = async (args: string[], input?: string) => {
    const child = Bun.spawn(["bun", artifact, ...args], {
      cwd: s.dir,
      env,
      stdin: input ? new Blob([input]) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, out, err };
  };
  let serving: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const build = Bun.spawn(
      ["bun", "build", "src/cli.ts", "--target=bun", "--outfile", artifact],
      { stdout: "ignore", stderr: "pipe" },
    );
    expect(await build.exited).toBe(0);
    const before = await readdir(s.dir);
    expect((await run(["--help"])).code).toBe(0);
    expect(await readdir(s.dir)).toEqual(before);
    const config = {
      ...s.config,
      data_dir: join(s.dir, "new-data"),
      accounts: s.config.accounts.filter((a) => a.platform === "matrix"),
      bindings: s.config.bindings.map((b) => ({
        ...b,
        scopes: b.scopes.filter((x) => x.account_id === "matrix-main"),
      })),
    };
    const configPath = join(s.dir, "post.toml");
    await writeFile(configPath, stringify(config as any), { mode: 0o600 });
    expect((await run(["config-check", "--config", configPath])).code).toBe(0);
    expect(await Bun.file(join(config.data_dir, "post.sqlite")).exists()).toBe(
      false,
    );
    await writeFile(configPath, stringify({ ...config, typo: true } as any));
    expect((await run(["serve", "--config", configPath])).code).toBe(1);
    expect(await Bun.file(join(config.data_dir, "post.sqlite")).exists()).toBe(
      false,
    );
    await writeFile(configPath, stringify(config as any));
    expect(
      (
        await run(
          [
            "credential-put",
            "--config",
            configPath,
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
            configPath,
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
    const issued = await run([
      "token-issue",
      "--config",
      configPath,
      "--agent",
      "cfl",
    ]);
    expect(issued.code).toBe(0);
    expect(issued.out.trim()).toHaveLength(43);
    const store = new Store(config);
    expect(store.authenticate(issued.out.trim())).toBe("cfl");
    expect((await run(["status", "--config", configPath])).code).toBe(1);
    store.close();
    serving = Bun.spawn(["bun", artifact, "serve", "--config", configPath], {
      cwd: s.dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = serving.stdout as ReadableStream<Uint8Array>;
    const reader = stdout.getReader();
    const initial = await reader.read();
    expect(new TextDecoder().decode(initial.value)).toContain('"ready":true');
    expect((await run(["status", "--config", configPath])).code).toBe(1);
    const initialStatus = JSON.parse(new TextDecoder().decode(initial.value));
    const client = new Client({ name: "crash-probe", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(initialStatus.url + "/mcp"), {
        requestInit: {
          headers: { Authorization: "Bearer " + issued.out.trim() },
        },
      }),
    );
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
    await serving.exited;
    await reader.cancel();
    await client.close();
    await pending;
    await until(() => p.aborts === 1);
    p.stall(false);
    serving = Bun.spawn(["bun", artifact, "serve", "--config", configPath], {
      cwd: s.dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const restartReader = (
      serving.stdout as ReadableStream<Uint8Array>
    ).getReader();
    const restarted = JSON.parse(
      new TextDecoder().decode((await restartReader.read()).value),
    );
    const retryClient = new Client({ name: "reconcile", version: "1" });
    await retryClient.connect(
      new StreamableHTTPClientTransport(new URL(restarted.url + "/mcp"), {
        requestInit: {
          headers: { Authorization: "Bearer " + issued.out.trim() },
        },
      }),
    );
    const reconciled = await retryClient.callTool({
      name: "send_message",
      arguments: args,
    });
    expect((reconciled.structuredContent as any).status).toBe("unknown");
    expect(p.sendCount).toBe(1);
    await retryClient.close();
    serving.kill("SIGTERM");
    expect(await serving.exited).toBe(0);
    await restartReader.cancel();
    serving = undefined;
    expect((await run(["status", "--config", configPath])).code).toBe(0);
    expect(
      (await run(["token-revoke", "--config", configPath, "--agent", "cfl"]))
        .code,
    ).toBe(0);
    expect((await stat(config.data_dir)).mode & 0o077).toBe(0);
    const bytes = await readFile(join(config.data_dir, "post.sqlite"));
    expect(bytes.includes(Buffer.from("secret-via-stdin"))).toBe(false);
  } finally {
    serving?.kill("SIGKILL");
    if (serving) await serving.exited;
    await p.close();
    await s.close();
  }
}, 20000);
