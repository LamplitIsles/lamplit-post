import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config, Scope } from "./config";
import type { PostDatabase, Tables } from "./models";
import { Ownership } from "./ownership";
import { Fault, need } from "./errors";
export const opaque = (prefix: string) =>
  prefix + "_" + randomBytes(18).toString("base64url");
export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export class Store {
  readonly tokens = new Map<string, string>();
  get key() {
    return this.owner.key;
  }
  constructor(
    public config: Config,
    public db: PostDatabase,
    public owner: Ownership,
  ) {}
  static async open(config: Config) {
    const { openStore } = await import("./runtime");
    return openStore(config);
  }
  close!: () => Promise<void>;
  async initialize() {
    const check = (await this.db.get("post_vault", { ref: "__keycheck" }))[0];
    if (check)
      need(
        (await this.secret("__keycheck", "__post", "key_check")) === "post-v1",
        "unavailable",
      );
    else {
      need(this.owner.fresh, "unavailable");
      await this.putSecret("__keycheck", "__post", "key_check", "post-v1");
    }
    for (const row of await this.db.get("post_tokens", {}))
      this.tokens.set(row.agent, row.digest);
    for (const row of await this.db.get("post_sends", {
      result: { $exists: false },
    }))
      await this.db.set(
        "post_sends",
        { agent: row.agent, request: row.request },
        {
          result: JSON.stringify({
            request_id: row.request,
            status: "unknown",
            parts: [],
            stored: false,
          }),
        },
      );

    mkdirSync(join(this.config.data_dir, "assets"), {
      mode: 0o700,
      recursive: true,
    });
  }
  async putSecret(ref: string, account: string, kind: string, secret: string) {
    const nonce = randomBytes(12),
      key_id = digest(this.key.toString("base64")).slice(0, 16);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify([ref, account, kind, 1, key_id])));
    const sealed = Buffer.concat([
      cipher.update(secret, "utf8"),
      cipher.final(),
    ]);
    await this.db.upsert("post_vault", [
      {
        ref,
        account,
        kind,
        key_id,
        nonce: Uint8Array.from(nonce).buffer,
        tag: Uint8Array.from(cipher.getAuthTag()).buffer,
        cipher: Uint8Array.from(sealed).buffer,
      },
    ]);
  }
  async secret(ref: string, account: string, kind: string) {
    const r = (await this.db.get("post_vault", { ref }))[0];
    return Store.unseal(this.key, r, ref, account, kind);
  }
  /** Also used at the provider startup boundary before any schema preparation. */
  static unseal(
    key: Buffer,
    r: Tables["post_vault"] | undefined,
    ref: string,
    account: string,
    kind: string,
  ) {
    need(r && r.account === account && r.kind === kind, "unavailable");
    try {
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(r.nonce));
      d.setAAD(Buffer.from(JSON.stringify([ref, account, kind, 1, r.key_id])));
      d.setAuthTag(Buffer.from(r.tag));
      return Buffer.concat([
        d.update(Buffer.from(r.cipher)),
        d.final(),
      ]).toString();
    } catch {
      throw new Fault("unavailable", "Vault authentication failed");
    }
  }

  async issue(agent: string) {
    need(
      this.config.bindings.some((b) => b.agent_id === agent),
      "invalid_request",
    );
    const token = randomBytes(32).toString("base64url");
    const value = digest(token);
    await this.db.upsert("post_tokens", [{ agent, digest: value }]);
    this.tokens.set(agent, value);
    return token;
  }
  async revoke(agent: string) {
    await this.db.withTransaction(async (db) => {
      await db.remove("post_tokens", { agent });
      await db.set(
        "post_deliveries",
        { agent, state: ["pending", "held"] },
        { state: "cancelled", category: "agent_revoked" },
      );
    });
    this.tokens.delete(agent);
  }
  authenticate(token: string) {
    if (this.owner.closed) return undefined;
    const value = digest(token);
    for (const [agent, hash] of this.tokens)
      if (
        hash === value &&
        this.config.bindings.some((b) => b.agent_id === agent)
      )
        return agent;
  }
  /** Read the existing immutable pins on this owner's provider before config writes. */
  async checkPins(config: Config) {
    const [identities, conversations] = await Promise.all([
      this.db.get("post_identities", {}),
      this.db.get("post_conversations", {}),
    ]);
    for (const account of config.accounts) {
      const row = identities.find((row) => row.account === account.id);
      if (row) checkIdentityPin(row, account.platform, account.native_id);
    }
    for (const binding of config.bindings)
      for (const scope of binding.scopes) {
        const row = conversations.find(
          (row) => row.id === scope.conversation_id,
        );
        if (row) checkConversationPin(row, scope);
        // A persisted native scope also owns its ID through the model's unique key.
        const native = conversations.find(
          (row) =>
            row.account === scope.account_id &&
            row.native === scope.native_id &&
            row.type === scope.type,
        );
        need(!native || native.id === scope.conversation_id, "conflict");
      }
  }
  async pin(account: string, platform: string, native: string) {
    await this.db.withTransaction(async (db) => {
      const r = (await db.get("post_identities", { account }))[0];
      if (r) checkIdentityPin(r, platform, native);
      else await db.create("post_identities", { account, platform, native });
    });
  }
  async gap(account: string, category: string) {
    await this.db.create("post_gaps", { account, category, at: Date.now() });
  }
}

export function checkIdentityPin(
  row: Tables["post_identities"],
  platform: string,
  native: string,
) {
  need(row.platform === platform && row.native === native, "conflict");
}
export function checkConversationPin(
  row: Tables["post_conversations"],
  scope: Scope,
) {
  need(
    row.account === scope.account_id &&
      row.native === scope.native_id &&
      row.type === scope.type,
    "conflict",
  );
}
