import { test, expect } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  cp,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { parse, stringify } from "yaml";
import { processFixture } from "./fixtures/process";
import { until } from "./fixtures/state";

import { rpc } from "./fixtures/console";

test("owned native app: Auth, Scanner and real pnpm Installer preserve one writable root", async () => {
  const root = await mkdtemp(join(tmpdir(), "post-managed-"));
  const app = join(root, "app"),
    home = join(root, "home"),
    privateDir = join(root, "private");
  for (const path of [app, home, privateDir])
    await mkdir(path, { mode: 0o700 });
  execFileSync("tar", [
    "-xzf",
    resolve("dist/lamplit-post-node24.tar.gz"),
    "-C",
    app,
  ]);
  const dependencyFiles = [
    "@koishijs/plugin-market/lib/node/index.js",
    "@koishijs/plugin-market/src/node/market.ts",
    "@koishijs/plugin-logger/lib/index.js",
    "@koishijs/client/client/data.ts",
    "@koishijs/plugin-console/dist/client.js",
    "@koishi-ce/plugin-database-sqlite/src/index.ts",
  ];
  const seeded = await Promise.all(
    dependencyFiles.map((file) => readFile(join(app, "node_modules", file))),
  );
  const manifestBeforeStart = await readFile(join(app, "package.json"));
  const lockBeforeStart = await readFile(join(app, "pnpm-lock.yaml"));
  const pnpm = process.env.POST_TEST_PNPM ?? process.env.npm_execpath!;
  const bin = join(root, "bin");
  await mkdir(bin);
  const trace = join(root, "pnpm-install.log");
  await writeFile(
    join(bin, "pnpm"),
    `#!/bin/sh\nexec '${pnpm}' "$@" > '${trace}' 2>&1\n`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    CI: "true",
    HOME: home,
    XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: home,
    COREPACK_ENABLE_NETWORK: "0",
    PNPM_HOME: join(home, "pnpm"),
    npm_config_userconfig: join(home, ".npmrc"),
    npm_config_globalconfig: join(home, "global.npmrc"),
    PATH: bin + ":" + dirname(pnpm) + ":" + process.env.PATH,
  };
  await writeFile(
    join(app, "pnpm-workspace.yaml"),
    (await readFile(join(app, "pnpm-workspace.yaml"), "utf8")) +
      "\n# Synthetic registry has no publication provenance.\ntrustLockfile: true\nminimumReleaseAge: 0\ntrustPolicy: off\nfetchRetries: 0\nfetchTimeout: 3000\n",
  );
  const requests: string[] = [];
  console.log("Owned fixture root:", root);
  const name = "koishi-plugin-owned-probe";
  const archives: Record<string, Buffer> = {};
  for (const version of ["1.0.0", "1.1.0"]) {
    const base = join(root, version),
      pkg = join(base, "package");
    await mkdir(pkg, { recursive: true });
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({
        name,
        version,
        main: "index.cjs",
        peerDependencies: { koishi: "^4.18.11" },
      }),
    );
    await writeFile(
      join(pkg, "index.cjs"),
      `const {Schema,Logger}=require('koishi');exports.name='owned-probe';exports.inject=['server'];exports.Config=Schema.object({value:Schema.string().default('initial')});exports.apply=(ctx,cfg)=>{ctx.server.get('/owned-probe',c=>c.body={version:'${version}',value:cfg.value,baseDir:ctx.baseDir,pm:process.env.npm_config_user_agent,execPath:process.env.npm_execpath});new Logger('qq').warn('SYNTHETIC_TRANSPORT_SECRET body=SYNTHETIC_BODY');};`,
    );
    const file = join(base, "probe.tgz");
    execFileSync("tar", ["-czf", file, "-C", base, "package"]);
    archives[version] = await readFile(file);
  }
  // Repackage the seed's exact published resources into an owned registry.
  // Only the probe is synthetic; no platform or public registry is contacted.
  const published = new Map<string, Record<string, any>>();
  const virtual = join(app, "node_modules/.pnpm");
  for (const entry of await readdir(virtual, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    const modules = join(virtual, entry.name, "node_modules");
    for (const top of await readdir(modules, { withFileTypes: true })) {
      if (!top.isDirectory()) continue;
      const paths = top.name.startsWith("@")
        ? (await readdir(join(modules, top.name), { withFileTypes: true }))
            .filter((e) => e.isDirectory())
            .map((e) => join(modules, top.name, e.name))
        : [join(modules, top.name)];
      for (const path of paths) {
        const meta = JSON.parse(
          await readFile(join(path, "package.json"), "utf8"),
        );
        if (meta.name === "koishi-plugin-post") continue;
        const versions = published.get(meta.name) ?? {};
        versions[meta.version] = { ...meta, $path: path };
        published.set(meta.name, versions);
      }
    }
  }
  let endpoint = "";
  const registry = createServer(async (req, res) => {
    const path = decodeURIComponent(req.url!);
    requests.push(path);
    res.setHeader("Content-Type", "application/json");
    if (path.startsWith("/-/v1/search"))
      return res.end(JSON.stringify({ objects: [], total: 0, version: 1 }));
    if (path.startsWith("/tar/")) {
      res.setHeader("Content-Type", "application/octet-stream");
      return res.end(archives[path.split("/")[2]]);
    }
    if (path === "/" + name)
      return res.end(
        JSON.stringify({
          name,
          "dist-tags": { latest: "1.1.0" },
          time: {
            "1.0.0": "2020-01-01T00:00:00Z",
            "1.1.0": "2020-01-02T00:00:00Z",
          },
          versions: Object.fromEntries(
            Object.keys(archives).map((version) => [
              version,
              {
                name,
                version,
                peerDependencies: { koishi: "^4.18.11" },
                dist: { tarball: endpoint + "/tar/" + version },
              },
            ]),
          ),
        }),
      );
    if (path.startsWith("/published/")) {
      const [, , encoded, version] = req.url!.split("/");
      const packageName = decodeURIComponent(encoded);
      const meta = published.get(packageName)?.[version];
      if (!meta) {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader("Content-Type", "application/octet-stream");
      return res.end(meta.$archive);
    }
    const versions = published.get(path.slice(1));
    if (versions)
      return res.end(
        JSON.stringify({
          name: path.slice(1),
          "dist-tags": { latest: Object.keys(versions).at(-1) },
          versions: Object.fromEntries(
            Object.entries(versions).map(([version, meta]) => [
              version,
              {
                ...meta,
                $path: undefined,
                $archive: undefined,
                dist: {
                  integrity: meta.$integrity,
                  tarball:
                    endpoint +
                    "/published/" +
                    encodeURIComponent(meta.name) +
                    "/" +
                    version,
                },
              },
            ]),
          ),
        }),
      );
    if (path === "/koishi-plugin-missing-probe") {
      res.statusCode = 404;
      return res.end("{}");
    }
    res.end(JSON.stringify({ name: path.slice(1), versions: {} }));
  });
  registry.listen(0, "127.0.0.1");
  await once(registry, "listening");
  endpoint = `http://127.0.0.1:${(registry.address() as any).port}`;
  // Let the native server select a test-owned port, then reserve explicit YAML ports.
  const free = async () => {
    const s = createServer();
    s.listen(0, "127.0.0.1");
    await once(s, "listening");
    const p = (s.address() as any).port;
    await new Promise<void>((r) => s.close(() => r()));
    return p;
  };
  const ui = await free(),
    api = await free(),
    configPath = join(app, "koishi.yml");
  const doc = parse(await readFile(configPath, "utf8"));
  doc.plugins.server.port = ui;
  doc.plugins.post.port = api;
  doc.plugins.market.registry = { endpoint, timeout: 1000 };
  await writeFile(configPath, stringify(doc), { mode: 0o600 });
  const offline = (args: string[]) =>
    processFixture(
      [join(app, "dist/cli.cjs"), ...args, "--config", configPath],
      { cwd: app, env },
    ).exited;
  let child: ReturnType<typeof processFixture> | undefined,
    client: Awaited<ReturnType<typeof rpc>> | undefined;
  try {
    expect(
      (await offline(["admin-provision", "--file", join(privateDir, "owner")]))
        .code,
    ).toBe(0);
    const secretFile = await readFile(join(privateDir, "owner"), "utf8"),
      password = secretFile.match(/Password: (.*)/)![1];
    expect(
      (await offline(["admin-provision", "--file", join(privateDir, "second")]))
        .out,
    ).toContain('"created":false');
    expect(await readdir(privateDir)).toEqual(["owner"]);
    child = processFixture(["run", "start"], {
      executable: pnpm,
      cwd: app,
      env,
    });
    await child.ready();
    expect(await readFile(join(app, "package.json"))).toEqual(
      manifestBeforeStart,
    );
    expect(await readFile(join(app, "pnpm-lock.yaml"))).toEqual(
      lockBeforeStart,
    );
    client = await rpc(`ws://127.0.0.1:${ui}/status`);
    expect(
      (await client!.call("manager/reload", "", "probe:test", {})).error,
    ).toBe("unauthorized");
    expect(
      (await client!.call("market/install", { [name]: "1.0.0" })).error,
    ).toBe("unauthorized");
    expect(
      (await client!.call("login/password", "admin", password)).error,
    ).toBeUndefined();
    await until(() => client!.data.get("user")?.authority === 5);
    const persistedSession = structuredClone(client!.data.get("user"));
    await until(() => client!.data.get("config")?.plugins);
    await until(() => client!.data.get("market")?.total === 0);
    expect(requests.some((x) => x.startsWith("/-/v1/search"))).toBe(true);
    expect(JSON.stringify(client!.data.get("config"))).not.toContain(password);
    // Seed an owned package-manager cache/registry mapping as fixture setup.
    // This is explicit setup, never a service-start action.
    client!.socket.close();
    client = undefined;
    child.kill("SIGTERM");
    await child.exited;
    child = undefined;
    // Repack the exact seed resources into a fully local registry. Revert the
    // recorded dependency patches in the copies so pnpm applies them normally.
    const copyRoot = join(root, "registry-packages");
    await mkdir(copyRoot);
    const patches = parse(
      await readFile(join(app, "pnpm-workspace.yaml"), "utf8"),
    ).patchedDependencies;
    for (const [packageName, versions] of published)
      for (const [version, meta] of Object.entries(versions)) {
        const base = join(
            copyRoot,
            encodeURIComponent(packageName) + "-" + version,
          ),
          pkg = join(base, "package");
        await mkdir(base);
        const patchFile = patches[packageName + "@" + version];
        let source = meta.$path;
        if (patchFile) {
          await cp(source, pkg, { recursive: true });
          execFileSync("patch", ["-R", "-p1", "-i", join(app, patchFile)], {
            cwd: pkg,
            stdio: "pipe",
          });
          source = pkg;
        }
        const file = join(base, "package.tgz");
        execFileSync("tar", [
          "-czf",
          file,
          "--transform=s,^,package/,",
          "-C",
          source,
          ".",
        ]);
        meta.$archive = await readFile(file);
        meta.$integrity =
          "sha512-" +
          createHash("sha512").update(meta.$archive).digest("base64");
      }
    // This owned registry has different tarballs; derive its own sole lock from
    // the unchanged package manifest rather than pretend they have upstream SRI.
    await rm(join(app, "pnpm-lock.yaml"));
    await rm(join(app, "node_modules"), { recursive: true, force: true });
    const prepared = await processFixture(["install", "--registry", endpoint], {
      executable: pnpm,
      cwd: app,
      env,
    }).exited;
    if (prepared.code)
      throw Error(
        "Owned dependency setup failed: " + prepared.out + prepared.err,
      );
    child = processFixture(["run", "start"], {
      executable: pnpm,
      cwd: app,
      env,
    });
    await child.ready();
    client = await rpc(`ws://127.0.0.1:${ui}/status`);
    expect(
      (
        await client!.call(
          "login/token",
          persistedSession.id,
          persistedSession.token,
        )
      ).error,
    ).toBeUndefined();
    await until(() => client!.data.get("config")?.plugins);
    const installed = await client!.call(
      "market/install",
      { [name]: "1.0.0" },
      true,
    );
    expect(installed.value === 0 || installed.closed === true).toBe(true);
    if (installed.closed) {
      await until(async () => {
        try {
          client = await rpc(`ws://127.0.0.1:${ui}/status`);
          return true;
        } catch {
          return false;
        }
      }, 10000);
      expect(
        (await client!.call("login/password", "admin", password)).error,
      ).toBeUndefined();
      await until(() => client!.data.get("config")?.plugins);
    }

    expect(
      JSON.parse(await readFile(join(app, "package.json"), "utf8"))
        .dependencies[name],
    ).toBe("1.0.0");
    expect(await readdir(app)).not.toContain("package-lock.json");
    expect(
      (
        await client!.call("manager/reload", "", "owned-probe:test", {
          value: "accepted",
        })
      ).error,
    ).toBeUndefined();
    await until(async () =>
      (await fetch(`http://127.0.0.1:${ui}/owned-probe`)).headers
        .get("content-type")
        ?.includes("application/json"),
    );
    const probe = await (
      await fetch(`http://127.0.0.1:${ui}/owned-probe`)
    ).json();
    expect(probe).toMatchObject({
      version: "1.0.0",
      value: "accepted",
      baseDir: app,
    });
    expect(probe.pm).toMatch(/^pnpm\/12\./);
    const filesystem = await import("node:fs/promises");
    expect(await filesystem.realpath(probe.execPath)).toBe(
      await filesystem.realpath(pnpm),
    );
    expect(
      (
        await client!.call("manager/unload", "", "owned-probe:test", {
          value: "accepted",
        })
      ).error,
    ).toBeUndefined();
    await until(
      async () =>
        !(await fetch(`http://127.0.0.1:${ui}/owned-probe`)).headers
          .get("content-type")
          ?.includes("application/json"),
    );
    const beforeUpdate = JSON.parse(
      await readFile(join(app, "data/owner.lock"), "utf8"),
    ).pid;
    const updated = await client!.call(
      "market/install",
      { [name]: "1.1.0" },
      true,
    );
    expect(updated.value === 0 || updated.closed === true).toBe(true);
    // Updating a cached module requests the guarded native worker restart.
    await until(async () => {
      try {
        return (
          JSON.parse(await readFile(join(app, "data/owner.lock"), "utf8"))
            .pid !== beforeUpdate
        );
      } catch {
        return false;
      }
    }, 10000);
    client!.socket.close();
    client = undefined;
    await until(async () => {
      try {
        client = await rpc(`ws://127.0.0.1:${ui}/status`);
        return true;
      } catch {
        return false;
      }
    }, 10000);
    expect(
      (await client!.call("login/password", "admin", password)).error,
    ).toBeUndefined();
    await until(() => client!.data.get("config")?.plugins);
    expect(
      (
        await client!.call("manager/reload", "", "owned-probe:test", {
          value: "updated",
        })
      ).error,
    ).toBeUndefined();
    await until(async () =>
      (await fetch(`http://127.0.0.1:${ui}/owned-probe`)).headers
        .get("content-type")
        ?.includes("application/json"),
    );
    expect(
      await (await fetch(`http://127.0.0.1:${ui}/owned-probe`)).json(),
    ).toMatchObject({ version: "1.1.0", value: "updated", baseDir: app });
    expect(
      (await client!.call("manager/unload", "", "owned-probe:test", {})).error,
    ).toBeUndefined();
    const beforeRemoval = JSON.parse(
      await readFile(join(app, "data/owner.lock"), "utf8"),
    ).pid;
    const removed = await client!.call(
      "market/install",
      { [name]: null },
      true,
    );
    expect(removed.value === 0 || removed.closed === true).toBe(true);
    await until(async () => {
      try {
        return (
          JSON.parse(await readFile(join(app, "data/owner.lock"), "utf8"))
            .pid !== beforeRemoval
        );
      } catch {
        return false;
      }
    }, 10000);
    client!.socket.close();
    await until(async () => {
      try {
        client = await rpc(`ws://127.0.0.1:${ui}/status`);
        return true;
      } catch {
        return false;
      }
    }, 10000);
    expect(
      (await client!.call("login/password", "admin", password)).error,
    ).toBeUndefined();
    await until(() => client!.data.get("config")?.plugins);
    expect(
      JSON.parse(await readFile(join(app, "package.json"), "utf8"))
        .dependencies[name],
    ).toBeUndefined();
    for (const [index, file] of dependencyFiles.entries())
      expect(await readFile(join(app, "node_modules", file))).toEqual(
        seeded[index],
      );
    const workspace = await readFile(join(app, "pnpm-workspace.yaml"), "utf8"),
      lock = await readFile(join(app, "pnpm-lock.yaml"), "utf8");
    expect(workspace).toContain("@koishijs/plugin-market@2.11.12");
    expect(workspace).toContain("@koishi-ce/plugin-database-sqlite@1.2.2");
    expect(lock).toContain("patchedDependencies");
    expect(
      (
        await client!.call(
          "market/install",
          { "koishi-plugin-missing-probe": "1.0.0" },
          true,
        )
      ).value,
    ).not.toBe(0);
    expect(
      (
        await client!.call(
          "market/install",
          { "koishi-plugin-missing-probe": null },
          true,
        )
      ).value,
    ).toBe(0);
    expect((await client!.call("user/logout")).error).toBeUndefined();
    expect((await client!.call("manager/app-reload", {})).error).toBe(
      "unauthorized",
    );
    const logs = (
      await Promise.all(
        (await readdir(join(app, "logs"))).map((f) =>
          readFile(join(app, "logs", f), "utf8"),
        ),
      )
    ).join("");
    expect(logs).not.toContain("SYNTHETIC_TRANSPORT_SECRET");
    expect(logs).not.toContain("SYNTHETIC_BODY");
    expect(logs).toContain("application_ready");
    expect(child.out + child.err).not.toContain(password);
  } catch (error) {
    console.error("OWNED APP OUTPUT", child?.out, child?.err);
    console.error(
      "REAL PNPM TRACE",
      await readFile(trace, "utf8").catch(() => "no install trace"),
    );
    console.error("REGISTRY REQUESTS", requests);
    throw error;
  } finally {
    client?.socket.terminate();
    child?.kill("SIGTERM");
    if (child) await child.exited;
    await new Promise<void>((r) => registry.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
}, 90000);
