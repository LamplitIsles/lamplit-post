import { readFile, stat } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { parse, stringify } from "smol-toml";
import { z } from "zod";
import { ConfigSchema, privateFile, resolveConfigPaths } from "./config";
import { Store, digest } from "./store";
import { atomicPrivate } from "./admin";
import { need } from "./errors";

// Deliberately isolated from normal configuration loading. Only this offline
// command understands the previous binding-owned recipient document.
const { agents, bindings, ...base } = ConfigSchema.shape;
const { account_ids, ...binding } = bindings.element.shape;
const legacy = z
  .object({
    ...base,
    bindings: z.array(
      z
        .object({
          ...binding,
          name: agents.element.shape.name,
          receiver_url: agents.element.shape.receiver_url,
          receiver_credential: agents.element.shape.receiver_credential,
        })
        .strict(),
    ),
  })
  .strict();

export async function convertConnections(
  path: string,
  checkpoint?: (stage: "staged" | "committed") => Promise<void>,
) {
  await privateFile(path);
  const parent = await stat(dirname(resolve(path)));
  need(!(parent.mode & 0o022), "invalid_request");
  const original = await readFile(path, "utf8"),
    raw = parse(original);
  const already = Object.hasOwn(raw, "agents");
  const old = already ? undefined : legacy.parse(raw);
  const grouped = new Map<string, NonNullable<typeof old>["bindings"]>();
  for (const b of old?.bindings ?? [])
    grouped.set(b.agent_id, [...(grouped.get(b.agent_id) ?? []), b]);
  const nextRaw = old
    ? {
        ...raw,
        agents: [...grouped].map(([id, bs]) => ({
          id,
          ...(bs[0]!.name ? { name: bs[0]!.name } : {}),
          receiver_url: bs[0]!.receiver_url,
          receiver_credential:
            "receiver_" +
            digest(
              JSON.stringify([id, bs.map((b) => b.receiver_credential)]),
            ).slice(0, 40),
        })),
        bindings: old.bindings.map(
          ({ name, receiver_url, receiver_credential, ...b }) => ({
            ...b,
            account_ids: [...new Set(b.scopes.map((s) => s.account_id))],
          }),
        ),
      }
    : raw;
  const config = resolveConfigPaths(
    ConfigSchema.parse(nextRaw),
    dirname(resolve(path)),
  );
  need(config.settings?.admin_file !== resolve(path), "invalid_request");
  // Conversion must never create a new installation or run send reconciliation.
  await privateFile(join(config.data_dir, "post.sqlite"));
  const store = new Store(config, "offline-conversion");
  try {
    const values: ((typeof config.agents)[number] & { secret: string })[] = [];
    for (const a of config.agents) {
      const bs = grouped.get(a.id);
      if (!bs) {
        await store.secret(a.receiver_credential, a.id, "receiver");
        continue;
      }
      const secret = await store.secret(
        bs[0]!.receiver_credential,
        bs[0]!.id,
        "receiver",
      );
      for (const b of bs)
        need(
          b.receiver_url === a.receiver_url &&
            (await store.secret(b.receiver_credential, b.id, "receiver")) ===
              secret,
          "conflict",
        );
      const existing = store.db
        .prepare("SELECT ref FROM vault WHERE ref=?")
        .get(a.receiver_credential);
      if (existing)
        need(
          (await store.secret(a.receiver_credential, a.id, "receiver")) ===
            secret,
          "conflict",
        );
      values.push({ ...a, secret });
    }
    // All conflicts are checked before any staged credential is written. Old
    // refs remain authoritative until the private, synced TOML rename commits.
    if (old) {
      store.transaction(() => {
        for (const a of values)
          store.putSecret(a.receiver_credential, a.id, "receiver", a.secret);
      });
      await checkpoint?.("staged");
      need((await readFile(path, "utf8")) === original, "conflict");
      await atomicPrivate(path, stringify(nextRaw));
      await checkpoint?.("committed");
    }
    // Also completes bounded cleanup on a repeated explicit invocation after a
    // post-commit interruption. Runtime startup never calls this command.
    store.transaction((db) => {
      for (const row of db
        .prepare("SELECT ref,account FROM vault WHERE kind='receiver'")
        .all())
        if (
          !config.agents.some((a) => a.receiver_credential === row.ref) &&
          config.bindings.some((b) => b.id === row.account)
        )
          db.prepare("DELETE FROM vault WHERE ref=? AND kind='receiver'").run(
            row.ref,
          );
    });
    return { converted: !!old, already_converted: already };
  } finally {
    await store.close();
  }
}
