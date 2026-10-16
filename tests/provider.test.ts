import { test, expect } from "vitest";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import type SQLite from "@koishi-ce/plugin-database-sqlite";
import { Store } from "../src/store";
import { stateFixture } from "./fixtures/state";
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
test("one provider isolates concurrent CRUD, transactions, batches, schema and stale async contexts", async () => {
  const s = await stateFixture("http://127.0.0.1:1", "http://127.0.0.1:2");
  const store = await Store.open(s.config),
    db = store.db;
  const driver = db.drivers[0] as unknown as SQLite;
  const add = (category: string) =>
    db.create("post_gaps", { account: "fixture", category, at: Date.now() });
  try {
    const entered = deferred(),
      release = deferred();
    const held = db.transact(async (tx) => {
      await tx.create("post_gaps", {
        account: "fixture",
        category: "rollback",
        at: 1,
      });
      entered.resolve();
      await release.promise;
      throw Error("owned rollback");
    });
    const rollback = expect(held).rejects.toThrow("owned rollback");
    await entered.promise;
    let outsideDone = false,
      readDone = false;
    const outside = add("outside").then(() => (outsideDone = true));
    const read = db.get("post_gaps", { category: "rollback" }).then((rows) => {
      expect(rows).toEqual([]);
      readDone = true;
    });
    await sleep(30);
    expect(outsideDone).toBe(false);
    expect(readDone).toBe(false);
    release.resolve();
    await rollback;
    await outside;
    await read;
    expect(await db.get("post_gaps", { category: "outside" })).toHaveLength(1);
    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        db.transact(async (tx) => {
          await tx.create("post_gaps", {
            account: "fixture",
            category: "tx" + i,
            at: 1,
          });
          await sleep(2);
          await tx.upsert("post_tokens", [
            { agent: "test" + i, digest: "digest" + i },
          ]);
        }),
      ),
    );
    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        driver.runBatch(async () => {
          await add("batch" + i);
          await sleep(2);
          await add("batch-end" + i);
        }),
      ),
    );
    await expect(
      driver.runBatch(async () => {
        await add("batch-error");
        throw Error("batch error");
      }),
    ).rejects.toThrow("batch error");
    expect(await db.get("post_gaps", { category: "batch-error" })).toEqual([]);
    await add("after-error");
    const wake = deferred();
    let stale!: Promise<unknown>;
    await driver.runBatch(async () => {
      stale = wake.promise.then(() => add("stale"));
    });
    const entered2 = deferred(),
      release2 = deferred();
    const second = db.transact(async (tx) => {
      await tx.create("post_gaps", {
        account: "fixture",
        category: "second-rollback",
        at: 1,
      });
      entered2.resolve();
      await release2.promise;
      throw Error("second");
    });
    const rolled = expect(second).rejects.toThrow("second");
    await entered2.promise;
    wake.resolve();
    let staleDone = false,
      schemaDone = false;
    stale.then(() => (staleDone = true));
    const schema = Promise.all([
      driver.prepare("post_gaps"),
      driver.getIndexes("post_gaps"),
    ]).then(() => (schemaDone = true));
    await sleep(30);
    expect(staleDone).toBe(false);
    expect(schemaDone).toBe(false);
    release2.resolve();
    await rolled;
    await stale;
    await schema;
    expect(await db.get("post_gaps", { category: "stale" })).toHaveLength(1);
    expect(await db.get("post_gaps", { category: "second-rollback" })).toEqual(
      [],
    );
  } finally {
    await store.close();
    await s.close();
  }
});
test("provider shutdown retains ownership while accepted work drains and rejects late work", async () => {
  const s = await stateFixture("http://127.0.0.1:1", "http://127.0.0.1:2");
  let store = await Store.open(s.config);
  const db = store.db,
    driver = db.drivers[0] as unknown as SQLite;
  const entered = deferred(),
    release = deferred();
  try {
    const active = driver.runBatch(async () => {
      entered.resolve();
      await release.promise;
      await db.create("post_gaps", {
        account: "fixture",
        category: "inflight",
        at: 1,
      });
    });
    await entered.promise;
    const queued = db.create("post_gaps", {
      account: "fixture",
      category: "queued",
      at: 2,
    });
    const closing = store.close();
    await sleep(20);
    await expect(Store.open(s.config)).rejects.toBeDefined();
    await expect(db.get("post_gaps", {})).rejects.toThrow("database closing");
    release.resolve();
    await active;
    await queued;
    await closing;
    store = await Store.open(s.config);
    expect(
      (await store.db.get("post_gaps", {})).map((r) => r.category),
    ).toEqual(["inflight", "queued"]);
  } finally {
    release.resolve();
    await store.close();
    await s.close();
  }
});
test("unknown existing storage is refused before framework schema preparation or key creation", async () => {
  const s = await stateFixture("http://127.0.0.1:1", "http://127.0.0.1:2");
  const config = {
    ...s.config,
    data_dir: join(s.dir, "unknown"),
    master_key_file: join(s.dir, "other-keys", "key"),
  };
  try {
    await mkdir(config.data_dir, { mode: 0o700 });
    const file = join(config.data_dir, "post.sqlite"),
      bytes = Buffer.from("unrecognized state");
    await writeFile(file, bytes, { mode: 0o600 });
    await expect(Store.open(config)).rejects.toThrow("Incompatible state");
    expect(await readFile(file)).toEqual(bytes);
    await expect(access(config.master_key_file)).rejects.toBeDefined();
  } finally {
    await s.close();
  }
});

test("failed transaction admission rejects during close and after BEGIN failure without stranding its session", async () => {
  const s = await stateFixture("http://127.0.0.1:1", "http://127.0.0.1:2");
  const store = await Store.open(s.config),
    db = store.db;
  const driver = db.drivers[0] as unknown as SQLite;
  const prepare = driver.db.prepare.bind(driver.db);
  let injected = false,
    userCallbacks = 0,
    completedOperations = 0;
  const statements: string[] = [];
  const transactRead = () =>
    db.transact(async (tx) => {
      userCallbacks++;
      const result = await tx.get("post_gaps", {});
      completedOperations++;
      return result;
    });
  const watchedPrepare = (sql: string) => {
    statements.push(sql);
    return prepare(sql);
  };
  driver.db.prepare = (sql: string) => {
    if (sql === "BEGIN TRANSACTION" && !injected) {
      injected = true;
      throw Error("owned BEGIN failure");
    }
    return watchedPrepare(sql);
  };
  const bounded = async (task: Promise<unknown>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        task,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error("transaction session timeout")),
            500,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const entered = deferred(),
    release = deferred();
  try {
    await expect(bounded(transactRead())).rejects.toThrow(
      "owned BEGIN failure",
    );
    expect(injected).toBe(true);
    expect(userCallbacks).toBe(1);
    expect(completedOperations).toBe(0);
    expect(statements.every((sql) => sql === "ROLLBACK")).toBe(true);
    driver.db.prepare = watchedPrepare;
    let expired!: typeof db;
    await db.transact(async (tx) => {
      expired = tx;
      await tx.get("post_gaps", {});
    });
    const beforeExpired = statements.length;
    await expect(bounded(expired.get("post_gaps", {}))).rejects.toThrow(
      "transaction session expired",
    );
    expect(statements).toHaveLength(beforeExpired);
    let enteredCallbacks = 0;
    await expect(
      db.transact(async (tx) => {
        enteredCallbacks++;
        await tx.get("post_gaps", {});
        throw Error("entered callback failure");
      }),
    ).rejects.toThrow("entered callback failure");
    expect(enteredCallbacks).toBe(1);
    await db.create("post_gaps", {
      account: "fixture",
      category: "after-begin-failure",
      at: 1,
    });
    await driver.runBatch(async () => {
      const beforeNested = statements.length;
      await expect(bounded(transactRead())).rejects.toThrow(
        "nested transactions are not supported",
      );
      expect(statements).toHaveLength(beforeNested);
      expect(userCallbacks).toBe(2);
      expect(completedOperations).toBe(0);
    });
    const active = driver.runBatch(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const closing = driver.stop();
    while (!(driver as any)._closing) await sleep(1);
    const beforeClosed = statements.length;
    await expect(bounded(transactRead())).rejects.toThrow("database closing");
    expect(statements).toHaveLength(beforeClosed);
    expect(userCallbacks).toBe(3);
    expect(completedOperations).toBe(0);
    release.resolve();
    await active;
    await closing;
    const afterClosed = statements.length;
    await expect(bounded(transactRead())).rejects.toThrow("database closing");
    expect(statements).toHaveLength(afterClosed);
    expect(userCallbacks).toBe(4);
    expect(completedOperations).toBe(0);
  } finally {
    release.resolve();
    driver.db.prepare = prepare;
    await store.close();
    await s.close();
  }
});
