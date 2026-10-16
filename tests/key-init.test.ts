import { test, expect } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store";
import { stateFixture } from "./fixtures/state";
test("fresh state publishes private external key once; restart reuses bytes; missing existing key never regenerates", async () => {
  const s = await stateFixture("http://127.0.0.1:1", "http://127.0.0.1:2");
  try {
    const config = {
      ...s.config,
      data_dir: join(s.dir, "fresh"),
      master_key_file: join(s.dir, "private", "key"),
    };
    let store = new Store(config);
    const first = await readFile(config.master_key_file);
    expect(first.length).toBe(32);
    expect((await stat(config.master_key_file)).mode & 0o077).toBe(0);
    expect((await stat(join(s.dir, "private"))).mode & 0o077).toBe(0);
    store.putSecret("example", "account", "platform", "secret");
    store.close();
    store = new Store(config);
    expect(await readFile(config.master_key_file)).toEqual(first);
    expect(store.secret("example", "account", "platform")).toBe("secret");
    store.close();
    await rm(config.master_key_file);
    expect(() => new Store(config)).toThrow();
    expect(await Bun.file(config.master_key_file).exists()).toBe(false);
    await writeFile(config.master_key_file, Buffer.alloc(31), { mode: 0o600 });
    expect(() => new Store(config)).toThrow();
    expect((await readFile(config.master_key_file)).length).toBe(31);
  } finally {
    await s.close();
  }
});
test("exclusive ownership refuses competing initialization without touching the winner key", async () => {
  const s = await stateFixture("http://127.0.0.1:1", "http://127.0.0.1:2");
  try {
    const config = {
      ...s.config,
      data_dir: join(s.dir, "fresh"),
      master_key_file: join(s.dir, "key"),
    };
    const store = new Store(config);
    const bytes = await readFile(config.master_key_file);
    expect(() => new Store(config)).toThrow();
    expect(await readFile(config.master_key_file)).toEqual(bytes);
    store.close();
  } finally {
    await s.close();
  }
});

test("simultaneous fresh processes share one published key or refuse; no losing-key ciphertext", async () => {
  const s = await stateFixture("http://127.0.0.1:1", "http://127.0.0.1:2");
  try {
    const config = {
      ...s.config,
      data_dir: join(s.dir, "race"),
      master_key_file: join(s.dir, "race-keys", "key"),
    };
    const entry = join(s.dir, "initialize.ts");
    const modulePath = new URL("../src/store.ts", import.meta.url).pathname;
    await writeFile(
      entry,
      `import {Store} from ${JSON.stringify(modulePath)};const config=JSON.parse(process.env.POST_TEST_CONFIG!);try{const s=new Store(config);s.putSecret('race','a','platform','same-secret');await Bun.sleep(100);s.close();}catch{process.exitCode=1;}`,
    );
    const spawn = () =>
      Bun.spawn(["bun", entry], {
        env: {
          ...process.env,
          POST_TEST_CONFIG: JSON.stringify(config),
          HOME: join(s.dir, "home"),
        },
        stdout: "ignore",
        stderr: "pipe",
      });
    const a = spawn(),
      b = spawn();
    const results = await Promise.all([a.exited, b.exited]);
    expect(results).toContain(0);
    expect(results.every((code) => code === 0 || code === 1)).toBe(true);
    const key = await readFile(config.master_key_file);
    const store = new Store(config);
    expect(store.secret("race", "a", "platform")).toBe("same-secret");
    store.close();
    expect(await readFile(config.master_key_file)).toEqual(key);
  } finally {
    await s.close();
  }
});
