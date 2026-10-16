import { Schema } from "@koishijs/core";
import { parse } from "yaml";
import { readFile, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { realpath } from "node:fs/promises";
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
export const ConfigSchema = Schema.transform(fields, (input) => {
  const cfg = fields(input);
  strict(fields, cfg);
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
});
export type Config = ReturnType<typeof ConfigSchema>;
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
  const entries = Object.keys(root.plugins).filter((key) =>
    /(^|\/)post-plugin\.cjs(?::[a-z0-9]+)?$/.test(key),
  );
  if (entries.length !== 1) throw new Error("One Post plugin entry required");
  const [plugin] = entries;
  if (JSON.stringify(root.plugins[plugin]).includes("${{"))
    throw new Error("Use literal Post configuration values");
  const cfg = ConfigSchema(root.plugins[plugin]);
  await validateConsole(root, plugin, cfg);
  cfg.data_dir = resolve(dirname(path), cfg.data_dir);
  cfg.master_key_file = resolve(dirname(path), cfg.master_key_file);
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

/** The unauthenticated native preview is an empty, fixed read-only plugin set. */
async function validateConsole(
  root: { plugins: Record<string, unknown>; [key: string]: unknown },
  post: string,
  cfg: Config,
) {
  const { plugins } = root;
  function hasConsole(entries: Record<string, unknown>): boolean {
    return Object.entries(entries).some(
      ([key, value]) =>
        /(?:^|\/)(?:plugin-)?console(?:\/|:|$)/.test(key) ||
        (key.split(":")[0] === "group" &&
          !!value &&
          typeof value === "object" &&
          hasConsole(value as Record<string, unknown>)),
    );
  }
  if (!hasConsole(plugins)) return;
  if (
    ["host", "port", "maxPort", "selfUrl"].some((key) =>
      Object.hasOwn(root, key),
    )
  )
    throw new Error(
      "Use only the explicit Console server entry, not legacy root listeners",
    );
  const entries = Object.keys(plugins).filter((key) => key !== post);
  const require = createRequire(resolve(process.argv[1]));
  const names = ["server", "console", "status"];
  if (
    entries.length !== names.length ||
    cfg.accounts.length ||
    cfg.bindings.length
  )
    throw new Error(
      "Console preview requires only native read-only plugins and empty Post",
    );
  for (const name of names) {
    const key = entries.find((key) =>
      key.includes("/@koishijs/plugin-" + name + "/"),
    );
    if (
      !key ||
      !key.startsWith("/") ||
      (await realpath(key.replace(/:[a-z0-9]+$/, ""))) !==
        (await realpath(require.resolve("@koishijs/plugin-" + name)))
    )
      throw new Error("Console plugin must resolve from this artifact");
    if (
      name === "server" &&
      Object.keys(plugins).indexOf(key) > Object.keys(plugins).indexOf(post)
    )
      throw new Error(
        "Console server must precede Post for lifecycle ownership",
      );
    const value = plugins[key] as Record<string, unknown>;
    const allowed =
      name === "server"
        ? ["host", "port"]
        : name === "console"
          ? ["uiPath", "apiPath", "selfUrl", "open", "devMode"]
          : [];
    if (!value || Object.keys(value).some((key) => !allowed.includes(key)))
      throw new Error("Unsupported Console preview options");
    if (
      name === "server" &&
      (value.host !== "127.0.0.1" ||
        !Number.isInteger(value.port) ||
        Number(value.port) < 1 ||
        Number(value.port) > 65535 ||
        value.port === cfg.port)
    )
      throw new Error("Console requires a separate loopback port");
    if (
      name === "console" &&
      (value.uiPath !== "" ||
        value.apiPath !== "/status" ||
        value.selfUrl !== "" ||
        value.open !== false ||
        value.devMode !== false)
    )
      throw new Error("Console requires native production resources at root");
  }
}
