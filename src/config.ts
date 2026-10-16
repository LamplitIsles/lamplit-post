import { Schema } from "@koishijs/core";
import { parse } from "yaml";
import { readFile, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
const id = () =>
  Schema.string()
    .pattern(/^[a-zA-Z0-9_-]{1,64}$/)
    .required();
const text = () => Schema.string().min(1).required();
const scope = Schema.object({
  account_id: id(),
  conversation_id: id(),
  native_id: text().max(256),
  type: Schema.union(["direct", "group"]).required(),
  senders: Schema.array(text()).default([]),
});
const fields = Schema.object({
  data_dir: text(),
  master_key_file: text(),
  hostname: Schema.const("127.0.0.1").default("127.0.0.1"),
  port: Schema.natural().max(65535).default(8787),
  max_asset_bytes: Schema.natural()
    .min(1)
    .max(64 * 1024 * 1024)
    .default(16 * 1024 * 1024),
  timeout_ms: Schema.natural().min(50).max(120000).default(30000),
  backlog_limit: Schema.natural()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .default(10000),
  accounts: Schema.array(
    Schema.object({
      id: id(),
      platform: Schema.union(["qq", "matrix"]).required(),
      credential: id(),
      native_id: text(),
      homeserver: Schema.string(),
    }),
  ).required(),
  bindings: Schema.array(
    Schema.object({
      id: id(),
      agent_id: id(),
      receiver_url: text(),
      receiver_credential: id(),
      scopes: Schema.array(scope).min(1).required(),
      wake: Schema.object({
        direct: Schema.boolean().default(false),
        mention: Schema.boolean().default(true),
        reply: Schema.boolean().default(true),
        aliases: Schema.array(text().max(128)).default([]),
      }).required(),
    }),
  ).required(),
});
/** Strictness derives from the same framework field schema, never a parallel schema. */
function strict(schema: Schema, value: any) {
  if (value == null) return;
  if (
    schema.type === "object" &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    for (const key of Object.keys(value)) {
      if (!schema.dict?.[key]) throw new Error("Unknown configuration field");
      strict(schema.dict[key], value[key]);
    }
  } else if (schema.type === "array" && Array.isArray(value))
    for (const item of value) strict(schema.inner!, item);
}
// The native Config client serializes this callback. Keep it closure-free.
const validated = Schema.transform(fields, (input) => {
  const cfg = input as ReturnType<typeof fields>;
  function url(value: string) {
    const u = new URL(value);
    if (
      !["http:", "https:"].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.hash ||
      u.search
    )
      throw new Error("Invalid endpoint");
  }
  for (const items of [cfg.accounts, cfg.bindings])
    if (new Set(items.map((x) => x.id)).size !== items.length)
      throw new Error("Duplicate ID");
  if (
    new Set(cfg.accounts.map((a) => JSON.stringify([a.platform, a.native_id])))
      .size !== cfg.accounts.length
  )
    throw new Error("Duplicate platform identity");
  const refs = [
    ...cfg.accounts.map((a) => a.credential),
    ...cfg.bindings.map((b) => b.receiver_credential),
  ];
  if (refs.includes("__keycheck"))
    throw new Error("Reserved credential reference");
  if (new Set(refs).size !== refs.length)
    throw new Error("Credential refs must be unique");
  for (const a of cfg.accounts) {
    if (a.platform === "matrix" && !a.homeserver)
      throw new Error("Matrix homeserver required");
    if (a.homeserver) url(a.homeserver);
  }
  const conversations = new Map<string, string>(),
    native = new Map<string, string>(),
    ids = new Map<string, string>();
  for (const b of cfg.bindings) {
    url(b.receiver_url);
    for (const s of b.scopes) {
      if (!cfg.accounts.some((a) => a.id === s.account_id))
        throw new Error("Unknown account");
      const key = JSON.stringify([s.account_id, s.conversation_id]),
        val = JSON.stringify([s.native_id, s.type]),
        nk = JSON.stringify([s.account_id, s.native_id, s.type]);
      if (conversations.has(key) && conversations.get(key) !== val)
        throw new Error("Conflicting conversation");
      if (native.has(nk) && native.get(nk) !== s.conversation_id)
        throw new Error("Native conversation has conflicting Post IDs");
      if (
        ids.has(s.conversation_id) &&
        ids.get(s.conversation_id) !== s.account_id
      )
        throw new Error("Conversation IDs must be globally unique");
      conversations.set(key, val);
      native.set(nk, s.conversation_id);
      ids.set(s.conversation_id, s.account_id);
    }
  }
  return cfg;
}).hidden();
// Stock Config renders object/intersection fields; transforms alone are opaque.
export const ConfigSchema = Schema.intersect([fields, validated]);
export type Config = ReturnType<typeof ConfigSchema>;
/** Server parse boundary derives strictness from the one framework field Schema. */
export function parseConfig(input: unknown): Config {
  // Loader separates these native entry fields from plugin options as well.
  const config =
    input && typeof input === "object" && !Array.isArray(input)
      ? Object.fromEntries(
          Object.entries(input).filter(
            ([key]) =>
              !["$label", "$collapsed", "$if", "$filter"].includes(key),
          ),
        )
      : input;
  strict(fields, config);
  return ConfigSchema(config as Parameters<typeof ConfigSchema>[0]);
}
export type Binding = Config["bindings"][number];
export type Scope = Binding["scopes"][number];
export type AccountConfig = Config["accounts"][number];
export async function loadConfig(path: string) {
  const parent = await stat(dirname(resolve(path)));
  const s = await stat(path);
  if (
    !parent.isDirectory() ||
    parent.mode & 0o022 ||
    !s.isFile() ||
    s.mode & 0o022
  )
    throw new Error("Config must not be writable by group/others");
  const root = parse(await readFile(path, "utf8"));
  if (!root || typeof root !== "object" || !root.plugins)
    throw new Error("One Post plugin entry required");
  if (root.daemon?.autoRestart !== false)
    throw new Error(
      "Set daemon.autoRestart to false; the service manager owns restart",
    );
  const entries = postEntries(root.plugins);
  if (entries.length !== 1) throw new Error("One Post plugin entry required");
  const [plugins, plugin] = entries[0];
  if (JSON.stringify(plugins[plugin]).includes("${{"))
    throw new Error("Use literal Post configuration values");
  const cfg = parseConfig(plugins[plugin]);
  validateApplication(root, cfg, dirname(path));
  return resolveConfigPaths(cfg, dirname(path));
}
export function resolveConfigPaths(raw: Config, base: string): Config {
  if (JSON.stringify(raw).includes("${{"))
    throw new Error("Use literal Post configuration values");
  const cfg = {
    ...raw,
    data_dir: resolve(base, raw.data_dir),
    master_key_file: resolve(base, raw.master_key_file),
  };
  if (
    cfg.master_key_file === cfg.data_dir ||
    cfg.master_key_file.startsWith(cfg.data_dir + "/")
  )
    throw new Error("Master key must be outside data directory");
  return cfg;
}
export async function privateFile(path: string) {
  const s = await stat(path);
  if (!s.isFile() || s.mode & 0o077)
    throw new Error("Private file permissions required");
}

/** Native groups remain ordinary loader configuration. */
export function postEntries(
  plugins: Record<string, any>,
): [Record<string, any>, string][] {
  return Object.entries(plugins).flatMap(([key, value]) => {
    const name = key.split(":")[0];
    if (name === "group") return postEntries(value ?? {});
    return name === "post" ||
      name === "koishi-plugin-post" ||
      /(^|\/)post-plugin\.cjs$/.test(name)
      ? [[plugins, key] as [Record<string, any>, string]]
      : [];
  });
}
export function validateLogRoot(root: string, data: string, base: string) {
  const logs = resolve(base, root),
    directory = resolve(base, data);
  if (logs === directory || logs.startsWith(directory + "/"))
    throw new Error("Logs must be outside Post data directory");
}
export function validateApplication(
  root: any,
  cfg: Config,
  base = process.cwd(),
) {
  if (
    ["host", "port", "maxPort", "selfUrl"].some((key) =>
      Object.hasOwn(root, key),
    )
  )
    throw new Error("Use an explicit server plugin for listeners");
  function visit(plugins: Record<string, any>) {
    for (const [key, value] of Object.entries(plugins)) {
      const name = key.split(":")[0];
      if (name === "group") visit(value ?? {});
      if (
        name === "server" &&
        (value.host !== "127.0.0.1" ||
          !Number.isInteger(value.port) ||
          value.port < 1 ||
          value.port > 65535 ||
          value.port === cfg.port)
      )
        throw new Error("Console requires a separate loopback port");
      if (name === "logger")
        validateLogRoot(value?.root ?? "data/logs", cfg.data_dir, base);
      if (
        name === "auth" &&
        (value?.admin?.enabled !== false || value?.admin?.password)
      )
        throw new Error(
          "Provision native administrator offline; disable startup admin reset",
        );
    }
  }
  visit(root.plugins);
}
