import { test, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:net";
import { once } from "node:events";
import {
  readFile,
  writeFile,
  mkdir,
  chmod,
  access,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { MatrixClient, EventType, MsgType } from "matrix-js-sdk";
import { Store } from "../src/store";
import { start } from "../src/runtime";
import { loadConfig } from "../src/config";
import { stringify } from "smol-toml";
import { stateFixture, until } from "./fixtures/state";
import { platformsFixture } from "./fixtures/platforms";

test("wrong/missing/tampered keys and foreign framework format refuse without changing bytes", async () => {
  const s = await stateFixture("http://127.0.0.1:1", "http://127.0.0.1:2");
  const file = join(s.config.data_dir, "post.sqlite"),
    before = await readFile(file),
    key = await readFile(s.config.master_key_file);
  try {
    await writeFile(s.config.master_key_file, Buffer.alloc(32, 8));
    await expect(Store.open(s.config)).rejects.toThrow();
    expect(await readFile(file)).toEqual(before);
    await unlink(s.config.master_key_file);
    await expect(Store.open(s.config)).rejects.toThrow();
    expect(await readFile(file)).toEqual(before);
    await expect(access(s.config.master_key_file)).rejects.toThrow();
    await writeFile(s.config.master_key_file, key, { mode: 0o600 });
    const db = new DatabaseSync(file);
    db.prepare("UPDATE vault SET tag=? WHERE ref='__keycheck'").run(
      Buffer.alloc(16),
    );
    db.close();
    const tampered = await readFile(file);
    await expect(Store.open(s.config)).rejects.toThrow();
    expect(await readFile(file)).toEqual(tampered);
    const foreign = join(s.dir, "framework");
    await mkdir(foreign, { mode: 0o700 });
    const f = join(foreign, "post.sqlite"),
      other = new DatabaseSync(f);
    other.exec(
      "PRAGMA application_id=1347375956;PRAGMA user_version=1;CREATE TABLE post_vault(ref TEXT,cipher BLOB);INSERT INTO post_vault VALUES('synthetic',x'1234')",
    );
    other.close();
    await chmod(f, 0o600);
    const bytes = await readFile(f);
    await expect(
      Store.open({ ...s.config, data_dir: foreign }),
    ).rejects.toThrow("Incompatible state");
    expect(await readFile(f)).toEqual(bytes);
    expect(await readFile(s.config.master_key_file)).toEqual(key);
    await expect(access(join(foreign, "owner.lock"))).rejects.toThrow();
  } finally {
    await s.close();
  }
});

test("one strict TOML config resolves paths from its parent without initializing state", async () => {
  const s = await stateFixture("http://127.0.0.1:1", "http://127.0.0.1:2");
  try {
    const directory = join(s.dir, "config");
    await mkdir(directory, { mode: 0o700 });
    const path = join(directory, "post.toml");
    await writeFile(
      path,
      stringify({
        ...s.config,
        data_dir: "../fresh",
        master_key_file: "../keys/master",
      }),
      { mode: 0o600 },
    );
    const config = await loadConfig(path);
    expect(config.data_dir).toBe(join(s.dir, "fresh"));
    expect(config.master_key_file).toBe(join(s.dir, "keys/master"));
    await expect(access(config.data_dir)).rejects.toThrow();
    await writeFile(path, 'data_dir: "yaml-is-not-toml"');
    await expect(loadConfig(path)).rejects.toThrow();
  } finally {
    await s.close();
  }
});

test("occupied API fails startup and drains platform I/O before lease reuse", async () => {
  const p = await platformsFixture(),
    s = await stateFixture(p.url, "http://127.0.0.1:1");
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  s.config.port = (server.address() as any).port;
  try {
    await expect(
      start(s.config, { qqOrigin: p.url, qqGateway: p.gateway }),
    ).rejects.toThrow();
    const store = await Store.open(s.config);
    await store.close();
    expect(p.sendCount).toBe(0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await p.close();
    await s.close();
  }
});

test("exact Matrix SDK timeout remains AbortError through anySignal and cancels native socket", async () => {
  const p = await platformsFixture();
  p.stall();
  const quiet: any = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    getChild() {
      return this;
    },
  };
  const client = new MatrixClient({
    baseUrl: p.url,
    userId: "@post:fixture",
    accessToken: "synthetic",
    localTimeoutMs: 100,
    logger: quiet,
  });
  try {
    const began = Date.now();
    const failure = await client
      .sendEvent("!room:fixture", EventType.RoomMessage, {
        body: "timeout",
        msgtype: MsgType.Text,
      })
      .catch((e) => e);
    expect(failure.name).toBe("AbortError");
    expect(Date.now() - began).toBeLessThan(1200);
    expect(p.sendCount).toBe(1);
    await until(() => p.aborts === 1);
  } finally {
    client.stopClient();
    await p.close();
  }
});
