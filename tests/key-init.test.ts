import { test, expect } from "vitest";
import { readFile, writeFile, rm, stat, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stringify } from "smol-toml";
import { Store } from "../src/store";
import { stateFixture } from "./fixtures/state";
import { processFixture } from "./fixtures/process";
test("fresh private external key is idempotent and missing existing key fails closed", async () => {
  const s = await stateFixture("http://127.0.0.1:1", "http://127.0.0.1:2");
  let store: Store | undefined;
  const config = {
    ...s.config,
    data_dir: join(s.dir, "fresh"),
    master_key_file: join(s.dir, "keys", "master"),
  };
  try {
    store = await Store.open(config);
    const bytes = await readFile(config.master_key_file);
    expect(bytes.length).toBe(32);
    expect((await stat(config.master_key_file)).mode & 0o077).toBe(0);
    expect((await stat(join(s.dir, "keys"))).mode & 0o077).toBe(0);
    await store.putSecret("example", "account", "platform", "secret");
    await store.close();
    store = await Store.open(config);
    expect(await readFile(config.master_key_file)).toEqual(bytes);
    expect(await store.secret("example", "account", "platform")).toBe("secret");
    await store.close();
    await rm(config.master_key_file);
    await expect(Store.open(config)).rejects.toBeDefined();
    await expect(access(config.master_key_file)).rejects.toBeDefined();
    await writeFile(config.master_key_file, Buffer.alloc(31), { mode: 0o600 });
    await expect(Store.open(config)).rejects.toBeDefined();
    expect((await readFile(config.master_key_file)).length).toBe(31);
  } finally {
    await store?.close();
    await s.close();
  }
});
test("exclusive owner refuses competing initialization without touching key", async () => {
  const s = await stateFixture("http://127.0.0.1:1", "http://127.0.0.1:2");
  let store: Store | undefined;
  try {
    store = await Store.open(s.config);
    const bytes = await readFile(s.config.master_key_file);
    await expect(Store.open(s.config)).rejects.toBeDefined();
    expect(await readFile(s.config.master_key_file)).toEqual(bytes);
  } finally {
    await store?.close();
    await s.close();
  }
});
test("simultaneous fresh Node processes publish one key or refuse; no losing-key ciphertext", async () => {
  const s = await stateFixture("http://127.0.0.1:1", "http://127.0.0.1:2");
  let store: Store | undefined;
  const config = {
    ...s.config,
    data_dir: join(s.dir, "race"),
    master_key_file: join(s.dir, "race-keys", "master"),
  };
  const path = join(s.dir, "post.toml");
  await writeFile(path, stringify(config), { mode: 0o600 });
  const args = [
    resolve("dist/cli.cjs"),
    "credential-put",
    "--config",
    path,
    "--ref",
    "qq-secret",
    "--account",
    "qq-main",
    "--kind",
    "platform",
  ];
  const options = {
    cwd: s.dir,
    env: { ...process.env, HOME: s.dir },
    input: "same-secret\n",
  };
  const a = processFixture(args, options),
    b = processFixture(args, options);
  try {
    const results = await Promise.all([a.exited, b.exited]);
    expect(results.some((x) => x.code === 0)).toBe(true);
    expect(results.every((x) => x.code === 0 || x.code === 1)).toBe(true);
    const key = await readFile(config.master_key_file);
    store = await Store.open(config);
    expect(await store.secret("qq-secret", "qq-main", "platform")).toBe(
      "same-secret",
    );
    expect(await readFile(config.master_key_file)).toEqual(key);
  } finally {
    a.kill("SIGKILL");
    b.kill("SIGKILL");
    await store?.close();
    await s.close();
  }
});
