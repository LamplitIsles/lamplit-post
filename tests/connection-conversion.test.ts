import { build } from "esbuild";
import { until } from "./fixtures/state";
import { test, expect } from "vitest";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { stringify, parse } from "smol-toml";
import { stateFixture } from "./fixtures/state";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { processFixture } from "./fixtures/process";
import { Store } from "../src/store";
import { Service } from "../src/service";
import { convertConnections } from "../src/convert-connections";
import { loadConfig, ConfigSchema } from "../src/config";

async function fixture() {
  const f = await stateFixture("http://127.0.0.1:1", "http://127.0.0.1:2");
  const path = f.dir + "/post.toml";
  const { agents, ...base } = f.config;
  const raw = {
    ...base,
    bindings: base.bindings.map(({ account_ids, ...b }) => ({
      ...b,
      name: "Owned consumer",
      receiver_url: agents[0]!.receiver_url,
      receiver_credential: "legacy-one",
    })),
  };
  raw.bindings.push({
    ...structuredClone(raw.bindings[0]!),
    id: "second-binding",
    receiver_credential: "legacy-two",
  });
  const store = await Store.open(f.config);
  const service = new Service(store);
  await store.pin("qq-main", "qq", "qq-app");
  await store.pin("matrix-main", "matrix", "@post:fixture");
  await service.observe("qq-main", {
    native_id: "conversion-history",
    conversation_native_id: "qq-group",
    conversation_type: "group",
    sender: "qq-owner",
    timestamp: 1,
    content: [{ type: "text", text: "owned immutable history" }],
    mentions: ["qq-app"],
    self_mentioned: true,
    catchup: false,
    assets: [],
  });
  await service.stop();
  await store.putSecret(
    "legacy-one",
    "cfl-binding",
    "receiver",
    "test-receiver",
  );
  await store.putSecret(
    "legacy-two",
    "second-binding",
    "receiver",
    "test-receiver",
  );
  store.db.prepare("DELETE FROM vault WHERE ref='receiver-secret'").run();
  store.db
    .prepare(
      "INSERT INTO sends(agent,request,input) VALUES ('cfl','unresolved','{}')",
    )
    .run();
  const tables = [
    "tokens",
    "identities",
    "conversations",
    "messages",
    "deliveries",
    "sends",
  ];
  const rows = Object.fromEntries(
    tables.map((t) => [t, store.db.prepare(`SELECT * FROM ${t}`).all()]),
  );
  const platform = store.db
    .prepare("SELECT * FROM vault WHERE kind='platform' ORDER BY ref")
    .all();
  await store.close();
  await writeFile(path, stringify(raw), { mode: 0o600 });
  await writeFile(
    f.dir + "/administrator.json",
    "owned unrelated administrator record",
    { mode: 0o600 },
  );
  return { ...f, path, raw, rows, platform };
}

test("explicit offline conversion preserves authority, pins, NULL sends, tokens, key/admin and platform ciphertext; repeated invocation is bounded", async () => {
  const f = await fixture();
  try {
    const key = await readFile(f.config.master_key_file),
      admin = await readFile(f.dir + "/administrator.json");
    await expect(loadConfig(f.path)).rejects.toThrow();
    expect(await convertConnections(f.path)).toEqual({
      converted: true,
      already_converted: false,
    });
    const cfg = await loadConfig(f.path);
    expect(cfg.agents).toHaveLength(1);
    expect(cfg.bindings.map((b) => b.id)).toEqual(
      f.raw.bindings.map((b) => b.id),
    );
    expect(cfg.bindings[0]!.account_ids).toEqual(["qq-main", "matrix-main"]);
    const store = new Store(cfg, "offline-conversion");
    try {
      expect(
        await store.secret(
          cfg.agents[0]!.receiver_credential,
          "cfl",
          "receiver",
        ),
      ).toBe("test-receiver");
      expect(
        store.db
          .prepare(
            "SELECT ref FROM vault WHERE ref IN ('legacy-one','legacy-two')",
          )
          .all(),
      ).toEqual([]);
      expect(
        store.db
          .prepare("SELECT * FROM vault WHERE kind='platform' ORDER BY ref")
          .all(),
      ).toEqual(f.platform);
      for (const [table, rows] of Object.entries(f.rows))
        expect(store.db.prepare(`SELECT * FROM ${table}`).all()).toEqual(rows);
      await expect(convertConnections(f.path)).rejects.toThrow(); // real lease
    } finally {
      await store.close();
    }
    const text = await readFile(f.path, "utf8");
    expect(await convertConnections(f.path)).toEqual({
      converted: false,
      already_converted: true,
    });
    expect(await readFile(f.path, "utf8")).toBe(text);
    expect(await readFile(f.config.master_key_file)).toEqual(key);
    expect(await readFile(f.dir + "/administrator.json")).toEqual(admin);
  } finally {
    await f.close();
  }
});

for (const disagreement of ["url", "secret"])
  test(`conversion refuses ${disagreement} conflict before vault/config mutation`, async () => {
    const f = await fixture();
    try {
      if (disagreement === "url")
        f.raw.bindings[1]!.receiver_url = "http://127.0.0.1:3";
      else {
        const store = new Store(f.config, "offline-conversion");
        await store.putSecret(
          "legacy-two",
          "second-binding",
          "receiver",
          "different-owned-secret",
        );
        await store.close();
      }
      await writeFile(f.path, stringify(f.raw), { mode: 0o600 });
      const before = await readFile(f.path),
        db = await readFile(f.config.data_dir + "/post.sqlite");
      await expect(convertConnections(f.path)).rejects.toThrow("conflict");
      expect(await readFile(f.path)).toEqual(before);
      expect(await readFile(f.config.data_dir + "/post.sqlite")).toEqual(db);
    } finally {
      await f.close();
    }
  });

for (const stage of ["staged", "committed"] as const)
  test(`explicit SIGKILL at ${stage} conversion retains an authenticated authority and reruns without replay`, async () => {
    const f = await fixture();
    try {
      const before = await readFile(f.path, "utf8");
      const runner = f.dir + "/conversion-runner.cjs";
      await build({
        stdin: {
          contents: `import { convertConnections } from "./src/convert-connections";
          convertConnections(process.argv[2], async stage => {
            if (stage !== process.argv[3]) return;
            console.log(stage);
            await new Promise(() => setInterval(() => {}, 1000));
          }).catch(() => { process.exitCode = 1; });`,
          resolveDir: process.cwd(),
        },
        outfile: runner,
        bundle: true,
        platform: "node",
        format: "cjs",
        loader: { ".sql": "text" },
      });
      const child = processFixture([runner, f.path, stage], { cwd: f.dir });
      try {
        await until(() => child.out.includes(stage));
        child.kill("SIGKILL");
        expect((await child.exited).signal).toBe("SIGKILL");
      } finally {
        child.kill("SIGKILL");
        await child.exited;
      }
      const raw = parse(await readFile(f.path, "utf8")) as any;
      const store = new Store(f.config, "offline-conversion");
      try {
        expect(
          store.db
            .prepare("SELECT result FROM sends WHERE request='unresolved'")
            .get()?.result,
        ).toBeNull();
        if (stage === "staged") {
          expect(await readFile(f.path, "utf8")).toBe(before);
          expect(
            await store.secret("legacy-one", "cfl-binding", "receiver"),
          ).toBe("test-receiver");
        } else {
          ConfigSchema.parse(raw);
          expect(
            await store.secret(
              raw.agents[0].receiver_credential,
              "cfl",
              "receiver",
            ),
          ).toBe("test-receiver");
        }
      } finally {
        await store.close();
      }
      await convertConnections(f.path);
      const cfg = await loadConfig(f.path),
        reopened = new Store(cfg, "offline-conversion");
      expect(
        reopened.db
          .prepare("SELECT result FROM sends WHERE request='unresolved'")
          .get()?.result,
      ).toBeNull();
      await reopened.close();
    } finally {
      await f.close();
    }
  });

test("extracted CLI explicitly converts owned legacy TOML, normal parsing refuses old format and repeat invocation does not reconcile sends", async () => {
  const f = await fixture();
  try {
    const artifact = f.dir + "/extracted";
    await mkdir(artifact);
    execFileSync("tar", [
      "-xzf",
      resolve("dist/lamplit-post-node24.tar.gz"),
      "-C",
      artifact,
    ]);
    const cli = artifact + "/dist/cli.cjs";
    const command = async (name: string) =>
      processFixture([cli, name, "--config", f.path], { cwd: f.dir }).exited;
    expect((await command("config-check")).code).toBe(1);
    const converted = await command("connections-convert");
    expect(converted.code).toBe(0);
    expect(JSON.parse(converted.out).converted).toBe(true);
    expect(converted.out + converted.err).not.toContain("test-receiver");
    expect((await command("config-check")).code).toBe(0);
    const again = await command("connections-convert");
    expect(again.code).toBe(0);
    expect(JSON.parse(again.out).already_converted).toBe(true);
    const cfg = await loadConfig(f.path),
      store = new Store(cfg, "offline-conversion");
    try {
      expect(
        store.db
          .prepare("SELECT result FROM sends WHERE request='unresolved'")
          .get()?.result,
      ).toBeNull();
      expect(
        await store.secret(
          cfg.agents[0]!.receiver_credential,
          "cfl",
          "receiver",
        ),
      ).toBe("test-receiver");
    } finally {
      await store.close();
    }
  } finally {
    await f.close();
  }
});
