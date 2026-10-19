import { test, expect } from "vitest";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { stringify } from "smol-toml";
import { platformsFixture } from "./fixtures/platforms";
import { stateFixture } from "./fixtures/state";
import { processFixture } from "./fixtures/process";
import { Store } from "../src/store";
import { Settings } from "../src/settings";

async function fixture() {
  const platform = await platformsFixture();
  const state = await stateFixture(platform.url, "http://127.0.0.1:1");
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  await new Promise<void>((r) => server.close(() => r()));
  const config = {
    ...state.config,
    accounts: state.config.accounts.filter((a) => a.platform === "matrix"),
    bindings: state.config.bindings.map((b) => ({
      ...b,
      scopes: b.scopes.filter((s) => s.account_id === "matrix-main"),
    })),
    settings: {
      port,
      origin: `http://127.0.0.1:${port}`,
      admin_file: join(state.dir, "admin.json"),
    },
  };
  const path = join(state.dir, "post.toml");
  await writeFile(path, stringify(config), { mode: 0o600 });
  return {
    platform,
    state,
    config,
    path,
    async close() {
      await platform.close();
      await state.close();
    },
  };
}

test("extracted CLI retains authenticated management after rejected persisted credential and repairs under the same lease", async () => {
  const f = await fixture();
  const root = join(f.state.dir, "artifact");
  await mkdir(root);
  execFileSync("tar", [
    "-xzf",
    resolve("dist/lamplit-post-node24.tar.gz"),
    "-C",
    root,
  ]);
  const env = {
    ...process.env,
    HOME: f.state.dir,
    XDG_CONFIG_HOME: f.state.dir,
    XDG_DATA_HOME: f.state.dir,
    XDG_STATE_HOME: f.state.dir,
    NODE_OPTIONS: "",
    npm_config_user_agent: "",
  };
  const run = (command: string, input?: string) =>
    processFixture([join(root, "dist/cli.cjs"), command, "--config", f.path], {
      cwd: f.state.dir,
      env,
      input,
    });
  let child: ReturnType<typeof run> | undefined;
  const password = "owned-recovery-password";
  try {
    expect((await run("admin-provision", password).exited).code).toBe(0);
    // First establish a valid persisted native identity, then reject its credential.
    child = run("serve");
    await child.ready();
    child.kill("SIGTERM");
    expect((await child.exited).code).toBe(0);
    f.platform.matrixCredential("owned-corrected-platform-secret");
    child = run("serve");
    const readiness = await child.settingsReady();
    expect(readiness.ready).toBe(false);
    expect(readiness.settings_ready).toBe(true);
    expect(readiness.url).toBeNull();
    expect(readiness.status.healthy).toBe(false);
    const origin = f.config.settings.origin;
    expect((await fetch(origin + "/api/settings")).status).toBe(401);
    const login = await fetch(origin + "/api/login", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    expect(login.status).toBe(200);
    const headers = {
      Cookie: login.headers.get("set-cookie")!.split(";")[0],
      Origin: origin,
      "Content-Type": "application/json",
      "X-Post-CSRF": (await login.json()).csrf,
    };
    const view = await (
      await fetch(origin + "/api/settings", { headers })
    ).json();
    expect(view.state).toBe("failed");
    expect(view.error).toBe("unavailable");
    expect(view.machine_url).toBeNull();
    expect(view.accounts[0].ready).toBe(false);
    const leasePath = join(f.config.data_dir, "owner.lock"),
      lease = await readFile(leasePath, "utf8");
    await expect(Store.open(f.config)).rejects.toThrow();
    const saved = await (
      await fetch(origin + "/api/settings", {
        method: "POST",
        headers,
        body: JSON.stringify({
          version: view.version,
          accounts: f.config.accounts,
          bindings: f.config.bindings,
          secrets: [
            {
              ref: "matrix-secret",
              account: "matrix-main",
              kind: "platform",
              value: "owned-corrected-platform-secret",
            },
          ],
        }),
      })
    ).json();
    expect(saved.applied).toBe(true);
    expect(saved.saved).toBe(true);
    expect(saved.state).toBe("applied");
    expect(saved.accounts[0].ready).toBe(true);
    expect((await fetch(saved.machine_url + "/healthz")).status).toBe(200);
    expect(await readFile(leasePath, "utf8")).toBe(lease);
    expect(
      JSON.stringify({
        view,
        saved,
        stdout: child.out,
        stderr: child.err,
      }).includes("owned-corrected-platform-secret"),
    ).toBe(false);
    child.kill("SIGTERM");
    expect((await child.exited).code).toBe(0);
    child = undefined;
    expect(existsSync(leasePath)).toBe(false);
    const reopened = await Store.open(f.config);
    await reopened.close();
    child = run("serve");
    expect((await child.ready()).status.healthy).toBe(true);
    child.kill("SIGTERM");
    expect((await child.exited).code).toBe(0);
    child = undefined;
  } finally {
    child?.kill("SIGKILL");
    if (child) await child.exited;
    await f.close();
  }
});

test("settings native failure retains the same Store for retry; missing vault credentials and cancellation remain fatal", async () => {
  const f = await fixture();
  const { provisionAdmin } = await import("../src/admin");
  await provisionAdmin(f.config.settings.admin_file, "owned-recovery-password");
  let app = new Settings(f.path, f.config);
  try {
    f.platform.matrixCredential("owned-corrected-platform-secret");
    await app.start();
    const owner = app.store;
    expect((await app.view()).state).toBe("failed");
    const saved = await app.save({
      version: app.version,
      accounts: f.config.accounts,
      bindings: f.config.bindings,
      secrets: [
        {
          ref: "matrix-secret",
          account: "matrix-main",
          kind: "platform",
          value: "owned-corrected-platform-secret",
        },
      ],
    });
    expect(saved.applied).toBe(true);
    expect(app.store).toBe(owner);
    expect(owner.owner.closed).toBe(false);
    await app.stop();
    const store = await Store.open(f.config);
    store.db.prepare("DELETE FROM vault WHERE ref=?").run("matrix-secret");
    await store.close();
    app = new Settings(f.path, f.config);
    await expect(app.start()).rejects.toThrow();
    expect(existsSync(join(f.config.data_dir, "owner.lock"))).toBe(false);
    app = new Settings(f.path, f.config);
    const starting = app.start().catch((e) => e);
    await app.stop();
    expect(await starting).toBeInstanceOf(Error);
    const reopened = await Store.open(f.config);
    await reopened.close();
  } finally {
    await app.stop();
    await f.close();
  }
});
