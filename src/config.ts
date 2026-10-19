import { z } from "zod";
import { parse } from "smol-toml";
import { readFile, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const ref = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const url = z
  .string()
  .url()
  .refine((s) => {
    const u = new URL(s);
    return (
      ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.hash &&
      !u.search
    );
  });
export function isShareURL(value: string) {
  try {
    const u = new URL(value);
    return (
      value.length <= 2048 &&
      u.protocol === "https:" &&
      ["qun.qq.com", "bot.q.qq.com", "q.qq.com"].includes(u.hostname) &&
      !u.username &&
      !u.password &&
      !u.hash &&
      (!u.port || u.port === "443") &&
      !/secret|token|password|credential/i.test(u.href)
    );
  } catch {
    return false;
  }
}
const scope = z
  .object({
    account_id: id,
    conversation_id: id,
    native_id: z.string().min(1).max(256),
    type: z.enum(["direct", "group"]),
    senders: z.array(z.string().min(1)).default([]),
  })
  .strict();
export const ConfigSchema = z
  .object({
    data_dir: z.string().min(1),
    master_key_file: z.string().min(1),
    hostname: z.literal("127.0.0.1").default("127.0.0.1"),
    port: z.number().int().min(0).max(65535).default(8787),
    max_asset_bytes: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024)
      .default(16 * 1024 * 1024),
    timeout_ms: z.number().int().min(50).max(120000).default(30000),
    backlog_limit: z.number().int().positive().default(10000),
    settings: z
      .object({
        port: z.number().int().min(0).max(65535).default(5140),
        origin: url,
        admin_file: z.string().min(1),
      })
      .strict()
      .optional(),
    accounts: z.array(
      z
        .object({
          id,
          platform: z.enum(["qq", "matrix"]),
          credential: ref,
          native_id: z.string().min(1),
          homeserver: url.optional(),
          name: z.string().min(1).max(128).optional(),
          share_url: z.string().refine(isShareURL).optional(),
        })
        .strict()
        .superRefine((v, c) => {
          if (v.platform === "matrix" && !v.homeserver)
            c.addIssue({
              code: "custom",
              message: "Matrix homeserver required",
            });
        }),
    ),
    bindings: z.array(
      z
        .object({
          id,
          agent_id: id,
          name: z.string().min(1).max(128).optional(),
          enabled: z.boolean().default(true),
          receiver_url: url,
          receiver_credential: ref,
          scopes: z.array(scope),
          wake: z
            .object({
              direct: z.boolean().default(false),
              mention: z.boolean().default(true),
              reply: z.boolean().default(true),
              aliases: z.array(z.string().min(1).max(128)).default([]),
            })
            .strict(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.settings) {
      const origin = new URL(v.settings.origin);
      if (
        origin.origin !== v.settings.origin ||
        !(
          origin.protocol === "https:" ||
          (origin.protocol === "http:" && origin.hostname === "127.0.0.1")
        )
      )
        c.addIssue({
          code: "custom",
          message: "Settings require a canonical HTTPS or loopback origin",
        });
      if (v.settings.admin_file === v.master_key_file)
        c.addIssue({
          code: "custom",
          message: "Administrator credential must be independent",
        });
    }
    for (const items of [v.accounts, v.bindings])
      if (new Set(items.map((x) => x.id)).size !== items.length)
        c.addIssue({ code: "custom", message: "Duplicate ID" });
    if (
      new Set(v.accounts.map((a) => JSON.stringify([a.platform, a.native_id])))
        .size !== v.accounts.length
    )
      c.addIssue({ code: "custom", message: "Duplicate platform identity" });
    const refs = [
      ...v.accounts.map((a) => a.credential),
      ...v.bindings.map((b) => b.receiver_credential),
    ];
    if (refs.includes("__keycheck"))
      c.addIssue({ code: "custom", message: "Reserved credential reference" });
    if (new Set(refs).size !== refs.length)
      c.addIssue({ code: "custom", message: "Credential refs must be unique" });
    const conv = new Map<string, string>();
    const native = new Map<string, string>();
    const ids = new Map<string, string>();
    for (const b of v.bindings)
      for (const s of b.scopes) {
        if (!v.accounts.some((a) => a.id === s.account_id))
          c.addIssue({ code: "custom", message: "Unknown account" });
        const key = s.account_id + ":" + s.conversation_id;
        const val = JSON.stringify([s.native_id, s.type]);
        if (conv.has(key) && conv.get(key) !== val)
          c.addIssue({ code: "custom", message: "Conflicting conversation" });
        const nativeKey = JSON.stringify([s.account_id, s.native_id, s.type]);
        if (
          native.has(nativeKey) &&
          native.get(nativeKey) !== s.conversation_id
        )
          c.addIssue({
            code: "custom",
            message: "Native conversation has conflicting Post IDs",
          });
        if (
          ids.has(s.conversation_id) &&
          ids.get(s.conversation_id) !== s.account_id
        )
          c.addIssue({
            code: "custom",
            message: "Conversation IDs must be globally unique",
          });
        native.set(nativeKey, s.conversation_id);
        ids.set(s.conversation_id, s.account_id);
        conv.set(key, val);
      }
  });
export type Config = z.infer<typeof ConfigSchema>;
export type Binding = Config["bindings"][number];
export type Scope = Binding["scopes"][number];
export type AccountConfig = Config["accounts"][number];
export const parseConfig = (input: unknown): Config =>
  ConfigSchema.parse(input);
export function resolveConfigPaths(raw: Config, base: string): Config {
  if (JSON.stringify(raw).includes("${{"))
    throw new Error("Use literal Post configuration values");
  const cfg = {
    ...raw,
    data_dir: resolve(base, raw.data_dir),
    master_key_file: resolve(base, raw.master_key_file),
    ...(raw.settings
      ? {
          settings: {
            ...raw.settings,
            admin_file: resolve(base, raw.settings.admin_file),
          },
        }
      : {}),
  };
  if (
    cfg.master_key_file === cfg.data_dir ||
    cfg.master_key_file.startsWith(cfg.data_dir + "/")
  )
    throw new Error("Master key must be outside data directory");
  if (
    cfg.settings &&
    (cfg.settings.admin_file === cfg.master_key_file ||
      cfg.settings.admin_file === cfg.data_dir ||
      cfg.settings.admin_file.startsWith(cfg.data_dir + "/"))
  )
    throw new Error(
      "Administrator credentials must be outside data and independent of key/config",
    );
  return cfg;
}
export async function loadConfig(path: string) {
  const parent = await stat(dirname(resolve(path))),
    permissions = await stat(path);
  if (
    !parent.isDirectory() ||
    parent.mode & 0o022 ||
    !permissions.isFile() ||
    permissions.mode & 0o022
  )
    throw new Error("Config must not be writable by group/others");
  const config = resolveConfigPaths(
    parseConfig(parse(await readFile(path, "utf8"))),
    dirname(resolve(path)),
  );
  if (config.settings?.admin_file === resolve(path))
    throw new Error("Independent administrator file required");
  return config;
}
export async function privateFile(path: string) {
  const s = await stat(path);
  if (!s.isFile() || s.mode & 0o077)
    throw new Error("Private file permissions required");
}
