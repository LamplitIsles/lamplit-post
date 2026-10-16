import { beforeAll, afterAll, test, expect } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  access,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, connect } from "node:net";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { parse, stringify } from "yaml";
import { processFixture } from "./fixtures/process";
let root: string, artifact: string, template: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "post-console-startup-"));
  artifact = join(root, "release");
  await mkdir(artifact);
  execFileSync("tar", [
    "-xzf",
    resolve("dist/lamplit-post-node24.tar.gz"),
    "-C",
    artifact,
  ]);
  template = await readFile(
    join(artifact, "examples/koishi.preview.yml"),
    "utf8",
  );
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
async function port() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const value = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return value;
}
async function open(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = connect(port, "127.0.0.1");
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(200, () => done(false));
  });
}
async function fixture(name: string, relative = false) {
  const parent = join(root, name),
    home = join(parent, "home");
  await mkdir(parent, { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  const document = parse(
    template.replaceAll("__POST_ARTIFACT_ROOT__", artifact),
  );
  const post = Object.keys(document.plugins).find((k) =>
    k.endsWith("post-plugin.cjs"),
  )!;
  const server = Object.keys(document.plugins).find((k) =>
    k.includes("plugin-server/"),
  )!;
  const ui = await port(),
    api = await port();
  document.plugins[server].port = ui;
  document.plugins[post].port = api;
  const data = join(parent, "data"),
    key = join(parent, "keys/post.key"),
    path = join(parent, "koishi.yml");
  if (!relative) {
    document.plugins[post].data_dir = data;
    document.plugins[post].master_key_file = key;
  }
  const write = () => writeFile(path, stringify(document), { mode: 0o600 });
  await write();
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: home,
    NODE_OPTIONS: "",
  };
  const spawn = (command: string) =>
    processFixture(
      [join(artifact, "dist/cli.cjs"), command, "--config", path],
      { cwd: parent, env },
    );
  const run = async (command: string) => {
    const child = spawn(command);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        child.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error(`Owned ${command} failed to exit within 8s`)),
            8000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
      await child.exited;
    }
  };
  return {
    parent,
    document,
    post,
    server,
    data,
    key,
    path,
    ui,
    api,
    write,
    run,
    spawn,
    lock: join(data, "owner.lock"),
  };
}
test.each(["legacy-listener", "nested-console"])(
  "preview preflight rejects %s without state",
  async (kind) => {
    const f = await fixture(kind);
    if (kind === "legacy-listener")
      Object.assign(f.document, {
        host: "0.0.0.0",
        port: await port(),
        selfUrl: "http://127.0.0.1",
      });
    else {
      const children = Object.fromEntries(
        Object.entries(f.document.plugins).filter(([k]) => k !== f.post),
      );
      f.document.plugins = {
        "group:preview": { ...children, config: {} },
        [f.post]: {
          ...f.document.plugins[f.post],
          accounts: [
            {
              id: "synthetic",
              platform: "qq",
              native_id: "never-connected",
              credential: "never-provisioned",
            },
          ],
        },
      };
    }
    await f.write();
    const before = await readFile(f.path),
      listing = await readdir(f.parent);
    expect((await f.run("config-check")).code).toBe(1);
    expect((await readFile(f.path)).equals(before)).toBe(true);
    expect(await readdir(f.parent)).toEqual(listing);
    expect(await open(f.ui)).toBe(false);
    expect(await open(f.api)).toBe(false);
  },
);
test.each(["held-owner", "invalid-state", "wrong-key"])(
  "fatal %s closes sibling listeners and exits without ready",
  async (kind) => {
    const f = await fixture(kind);
    let owner: Buffer | undefined, database: Buffer | undefined;
    if (kind === "held-owner") {
      await mkdir(f.data, { mode: 0o700 });
      owner = Buffer.from(JSON.stringify({ pid: process.pid }));
      await writeFile(f.lock, owner, { mode: 0o600 });
    } else {
      if (kind === "wrong-key") expect((await f.run("status")).code).toBe(0);
      else {
        await mkdir(f.data, { mode: 0o700 });
        await mkdir(join(f.parent, "keys"), { mode: 0o700 });
        await writeFile(
          join(f.data, "post.sqlite"),
          "owned invalid SQLite header",
          { mode: 0o600 },
        );
      }
      await writeFile(f.key, Buffer.alloc(32, 13), { mode: 0o600 });
      database = await readFile(join(f.data, "post.sqlite"));
    }
    const result = await f.run("serve");
    expect(result.code).toBe(1);
    expect(result.out).not.toContain('"ready":true');
    expect(await open(f.ui)).toBe(false);
    expect(await open(f.api)).toBe(false);
    if (owner) expect((await readFile(f.lock)).equals(owner)).toBe(true);
    else await expect(access(f.lock)).rejects.toThrow();
    if (database)
      expect(
        (await readFile(join(f.data, "post.sqlite"))).equals(database),
      ).toBe(true);
  },
);
test("canonical relative state shares the config-parent owner with offline CLI and restart", async () => {
  const f = await fixture("relative-state", true);
  let child: ReturnType<typeof f.spawn> | undefined;
  try {
    child = f.spawn("serve");
    await child.ready();
    expect((await f.run("status")).code).toBe(1);
    const key = await readFile(f.key),
      database = await stat(join(f.data, "post.sqlite"));
    await expect(access(f.lock)).resolves.toBeUndefined();
    await expect(access(join(artifact, "data"))).rejects.toThrow();
    await expect(access(join(artifact, "keys"))).rejects.toThrow();
    child.kill("SIGTERM");
    await child.exited;
    child = undefined;
    expect((await f.run("status")).code).toBe(0);
    child = f.spawn("serve");
    await child.ready();
    expect((await readFile(f.key)).equals(key)).toBe(true);
    expect((await stat(join(f.data, "post.sqlite"))).ino).toBe(database.ino);
    expect((await f.run("status")).code).toBe(1);
  } finally {
    child?.kill("SIGTERM");
    if (child) await child.exited;
  }
});
