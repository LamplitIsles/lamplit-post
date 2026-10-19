import { test, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { stringify } from "smol-toml";
import { processFixture } from "./fixtures/process";
async function freePort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as any).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}
test("extracted artifact provisions separate admin, serves complete local UI, applies, stops and reopens", async () => {
  const dir = await mkdtemp(join(tmpdir(), "post-ui-artifact-"));
  const root = join(dir, "artifact");
  await mkdir(root);
  execFileSync("tar", [
    "-xzf",
    resolve("dist/lamplit-post-node24.tar.gz"),
    "-C",
    root,
  ]);
  const cli = join(root, "dist/cli.cjs"),
    path = join(dir, "post.toml"),
    port = await freePort(),
    origin = `http://127.0.0.1:${port}`;
  const config = {
    data_dir: join(dir, "data"),
    master_key_file: join(dir, "master.key"),
    port: 0,
    accounts: [],
    bindings: [],
    settings: { port, origin, admin_file: join(dir, "admin.json") },
  };
  await writeFile(path, stringify(config), { mode: 0o600 });
  const env = {
    ...process.env,
    HOME: dir,
    XDG_CONFIG_HOME: dir,
    XDG_DATA_HOME: dir,
    XDG_STATE_HOME: dir,
    npm_config_user_agent: "",
  };
  const run = (args: string[], input?: string) =>
    processFixture([cli, ...args], { env, cwd: dir, input });
  let serving: ReturnType<typeof run> | undefined;
  try {
    expect(
      (
        await run(
          ["admin-provision", "--config", path],
          "artifact-owned-password",
        ).exited
      ).code,
    ).toBe(0);
    serving = run(["serve", "--config", path]);
    await serving.ready();
    const html = await (await fetch(origin)).text();
    expect(html).toContain("Post 设置");
    const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(assets.length).toBeGreaterThan(2);
    for (const asset of assets) {
      expect(asset.startsWith("/")).toBe(true);
      expect((await fetch(origin + asset)).status).toBe(200);
    }
    const login = await fetch(origin + "/api/login", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ password: "artifact-owned-password" }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0],
      csrf = (await login.json()).csrf;
    expect(login.headers.get("set-cookie")).toContain("HttpOnly");
    expect(login.headers.get("set-cookie")).toContain("SameSite=Strict");
    const headers = {
      Cookie: cookie,
      Origin: origin,
      "Content-Type": "application/json",
      "X-Post-CSRF": csrf,
    };
    const view = await (
      await fetch(origin + "/api/settings", { headers })
    ).json();
    const receiverSecret = "artifact-distinct-receiver";
    const response = await fetch(origin + "/api/settings", {
      method: "POST",
      headers,
      body: JSON.stringify({
        version: view.version,
        accounts: [],
        bindings: [
          {
            id: "artifact",
            agent_id: "artifact",
            name: "Artifact",
            enabled: true,
            receiver_url: "http://127.0.0.1:1",
            receiver_credential: "receiver",
            scopes: [],
            wake: {},
          },
        ],
        secrets: [
          {
            ref: "receiver",
            account: "artifact",
            kind: "receiver",
            value: receiverSecret,
          },
        ],
      }),
    });
    expect((await response.json()).applied).toBe(true);
    expect(await readFile(path, "utf8")).not.toContain(receiverSecret);
    serving.kill("SIGTERM");
    expect((await serving.exited).code).toBe(0);
    serving = run(["serve", "--config", path]);
    await serving.ready();
    expect((await fetch(origin + "/api/settings", { headers })).status).toBe(
      401,
    );
    const newLogin = await fetch(origin + "/api/login", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ password: "artifact-owned-password" }),
    });
    const newCookie = newLogin.headers.get("set-cookie")!.split(";")[0];
    expect(
      (
        await (
          await fetch(origin + "/api/settings", {
            headers: { Cookie: newCookie },
          })
        ).json()
      ).bindings[0].agent_id,
    ).toBe("artifact");
    expect(serving.out + serving.err).not.toContain("artifact-owned-password");
    expect(serving.out + serving.err).not.toContain(receiverSecret);
    serving.kill("SIGTERM");
    expect((await serving.exited).code).toBe(0);
  } finally {
    if (serving) {
      serving.kill("SIGKILL");
      await serving.exited;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
