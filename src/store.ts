import type { Tables } from "./models";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import schema from "./schema.sql";
import { join } from "node:path";
import type { Config, Scope } from "./config";
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
  db: DatabaseSync;
  owner: Ownership;
  constructor(
    public config: Config,
    mode: "runtime" | "offline-conversion" = "runtime",
  ) {
    this.owner = new Ownership(config);
    let db: DatabaseSync | undefined;
    try {
      this.db = db = new DatabaseSync(join(config.data_dir, "post.sqlite"));
      if (!this.owner.fresh) {
        need(
          db.prepare("SELECT version FROM meta").get()?.version === 1,
          "unavailable",
        );
        const row = db
          .prepare("SELECT * FROM vault WHERE ref = ?")
          .get("__keycheck") as unknown as Tables["vault"];
        need(
          Store.unseal(this.key, row, "__keycheck", "__post", "key_check") ===
            "post-v1",
          "unavailable",
        );
      }
      // Authenticate existing state before ANY writable PRAGMA or DDL.
      db.exec(
        "PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;",
      );
      if (this.owner.fresh) {
        db.exec("PRAGMA application_id=1347375956; PRAGMA user_version=2;");
        db.exec(schema);
      }
      if (mode === "runtime") {
        chmodSync(join(config.data_dir, "post.sqlite"), 0o600);
        this.initialize();
      }
    } catch (e) {
      db?.close();
      this.owner.close();
      throw e;
    }
  }
  static async open(config: Config) {
    return new Store(config);
  }
  async close() {
    if (this.owner.closed) return;
    this.db.close();
    this.owner.close();
  }
  transaction<T>(
    work: (db: DatabaseSync) => T extends PromiseLike<unknown> ? never : T,
  ): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work(this.db);
      if (value && typeof (value as any).then === "function")
        throw new Fault("internal");
      this.db.exec("COMMIT");
      return value as T;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  private initialize() {
    if (this.owner.fresh)
      this.putSecret("__keycheck", "__post", "key_check", "post-v1");
    for (const row of this.db
      .prepare("SELECT * FROM tokens")
      .all() as unknown as Tables["tokens"][])
      this.tokens.set(row.agent, row.digest);
    for (const row of this.db
      .prepare("SELECT * FROM sends WHERE `result` IS NULL")
      .all() as unknown as Tables["sends"][])
      this.db
        .prepare(
          "UPDATE sends SET `result` = ? WHERE `agent` = ? AND `request` = ?",
        )
        .run(
          JSON.stringify({
            request_id: row.request,
            status: "unknown",
            parts: [],
            stored: false,
          }),
          row.agent,
          row.request,
        );

    mkdirSync(join(this.config.data_dir, "assets"), {
      mode: 0o700,
      recursive: true,
    });
  }
  putSecret(ref: string, account: string, kind: string, secret: string) {
    const nonce = randomBytes(12),
      key_id = digest(this.key.toString("base64")).slice(0, 16);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify([ref, account, kind, 1, key_id])));
    const sealed = Buffer.concat([
      cipher.update(secret, "utf8"),
      cipher.final(),
    ]);
    this.db
      .prepare(
        "INSERT INTO vault (`ref`,`account`,`kind`,`key_id`,`nonce`,`tag`,`cipher`) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO UPDATE SET `ref` = excluded.`ref`,`account` = excluded.`account`,`kind` = excluded.`kind`,`key_id` = excluded.`key_id`,`nonce` = excluded.`nonce`,`tag` = excluded.`tag`,`cipher` = excluded.`cipher`",
      )
      .run(ref, account, kind, key_id, nonce, cipher.getAuthTag(), sealed);
  }
  async secret(ref: string, account: string, kind: string) {
    const r = (
      this.db
        .prepare("SELECT * FROM vault WHERE `ref` = ?")
        .all(ref) as unknown as Tables["vault"][]
    )[0];
    return Store.unseal(this.key, r, ref, account, kind);
  }
  /** Authenticate purpose-bound ciphertext before writable initialization. */
  static unseal(
    key: Buffer,
    r: Tables["vault"] | undefined,
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
      this.config.agents.some((a) => a.id === agent),
      "invalid_request",
    );
    const token = randomBytes(32).toString("base64url");
    const value = digest(token);
    this.db
      .prepare(
        "INSERT INTO tokens (`agent`,`digest`) VALUES (?,?) ON CONFLICT DO UPDATE SET `agent` = excluded.`agent`,`digest` = excluded.`digest`",
      )
      .run(agent, value);
    this.tokens.set(agent, value);
    return token;
  }
  async revoke(agent: string) {
    this.transaction((db) => {
      db.prepare("DELETE FROM tokens WHERE `agent` = ?").run(agent);
      db.prepare(
        "UPDATE deliveries SET `state` = ?,`category` = ? WHERE `agent` = ? AND `state` IN (?,?)",
      ).run("cancelled", "agent_revoked", agent, ...["pending", "held"]);
    });
    this.tokens.delete(agent);
  }
  authenticate(token: string) {
    if (this.owner.closed) return undefined;
    const value = digest(token);
    for (const [agent, hash] of this.tokens)
      if (hash === value && this.config.agents.some((a) => a.id === agent))
        return agent;
  }
  async pin(account: string, platform: string, native: string) {
    this.transaction((db) => {
      const r = (
        db
          .prepare("SELECT * FROM identities WHERE `account` = ?")
          .all(account) as unknown as Tables["identities"][]
      )[0];
      if (r) checkIdentityPin(r, platform, native);
      else
        db
          .prepare(
            "INSERT INTO identities (`account`,`platform`,`native`) VALUES (?,?,?) RETURNING *",
          )
          .get(account, platform, native) as unknown as Tables["identities"];
    });
  }
  async gap(account: string, category: string) {
    this.db
      .prepare(
        "INSERT INTO gaps (`account`,`category`,`at`) VALUES (?,?,?) RETURNING *",
      )
      .get(account, category, Date.now()) as unknown as Tables["gaps"];
  }
}

export function checkIdentityPin(
  row: Tables["identities"],
  platform: string,
  native: string,
) {
  need(row.platform === platform && row.native === native, "conflict");
}
export function checkConversationPin(
  row: Tables["conversations"],
  scope: Scope,
) {
  need(
    row.account === scope.account_id &&
      row.native === scope.native_id &&
      row.type === scope.type,
    "conflict",
  );
}
