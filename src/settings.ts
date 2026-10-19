import { readFile } from "node:fs/promises";
import { parse, stringify } from "smol-toml";
import {
  parseConfig,
  resolveConfigPaths,
  privateFile,
  type Config,
} from "./config";
import { dirname, resolve } from "node:path";
import { Application } from "./runtime";
import type { TransportFixture } from "./host";
import { Store, digest } from "./store";
import { need } from "./errors";
import { atomicPrivate } from "./admin";
export class Settings {
  app!: Application;
  store!: Store;
  pending: Promise<unknown> = Promise.resolve();
  closed = false;
  private starting?: Promise<void>;
  state = "applied";
  version = "";
  constructor(
    public path: string,
    public config: Config,
    public fixture?: TransportFixture,
  ) {}
  start() {
    return (this.starting ??= (async () => {
      await privateFile(this.config.settings!.admin_file);
      need(!this.closed, "unavailable");
      this.version = digest(await readFile(this.path, "utf8"));
      need(!this.closed, "unavailable");
      this.store = await Store.open(this.config);
      this.app = new Application(this.config, this.fixture, this.store);
      try {
        this.validate(this.config);
        for (const a of this.config.accounts)
          await this.store.secret(a.credential, a.id, "platform");
        for (const b of this.config.bindings)
          await this.store.secret(b.receiver_credential, b.id, "receiver");
        need(!this.closed, "unavailable");
        await this.app.start();
        need(!this.closed, "unavailable");
      } catch (e) {
        await this.app.stop(false);
        if (this.closed || !this.app.transportFailed) {
          await this.store.close();
          throw e;
        }
        this.state = "failed";
      }
    })());
  }
  serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.pending.then(() => {
      need(!this.closed, "unavailable");
      return work();
    });
    this.pending = result.catch(() => {});
    return result;
  }
  async view() {
    const text = await readFile(this.path, "utf8");
    need(digest(text) === this.version, "conflict");
    const credential = (ref: string, account: string, kind: string) =>
      !!this.store.db
        .prepare("SELECT ref FROM vault WHERE ref=? AND account=? AND kind=?")
        .get(ref, account, kind);
    return {
      version: digest(text),
      state: this.state,
      error: this.state === "failed" ? "unavailable" : null,
      machine_url: this.app.http?.url ?? null,
      accounts: this.config.accounts.map((a) => ({
        ...a,
        hasCredential: credential(a.credential, a.id, "platform"),
        ready: this.app.service?.platforms.get(a.id)?.ready ?? false,
      })),
      bindings: this.config.bindings.map((b) => ({
        ...b,
        hasCredential: credential(b.receiver_credential, b.id, "receiver"),
        hasToken: this.store.tokens.has(b.agent_id),
      })),
    };
  }
  validate(next: Config) {
    for (const key of Object.keys(this.config).filter(
      (k) => !["accounts", "bindings"].includes(k),
    ) as (keyof Config)[])
      need(
        JSON.stringify(next[key]) === JSON.stringify(this.config[key]),
        "invalid_request",
      );
    for (const a of next.accounts) {
      const rows = this.store.db
        .prepare(
          "SELECT * FROM identities WHERE account=? OR (platform=? AND native=?)",
        )
        .all(a.id, a.platform, a.native_id);
      for (const r of rows)
        need(
          r.account === a.id &&
            r.platform === a.platform &&
            r.native === a.native_id,
          "conflict",
        );
      const old = this.config.accounts.find((o) => o.id === a.id);
      if (old)
        need(
          old.platform === a.platform &&
            old.native_id === a.native_id &&
            old.homeserver === a.homeserver &&
            old.credential === a.credential,
          "conflict",
        );
    }
    for (const b of next.bindings) {
      const old = this.config.bindings.find((o) => o.id === b.id);
      if (old)
        need(
          old.agent_id === b.agent_id &&
            old.receiver_credential === b.receiver_credential,
          "conflict",
        );
    }
    for (const b of next.bindings)
      for (const s of b.scopes) {
        const rows = this.store.db
          .prepare(
            "SELECT * FROM conversations WHERE id=? OR (account=? AND native=? AND type=?)",
          )
          .all(s.conversation_id, s.account_id, s.native_id, s.type);
        for (const r of rows)
          need(
            r.id === s.conversation_id &&
              r.account === s.account_id &&
              r.native === s.native_id &&
              r.type === s.type,
            "conflict",
          );
      }
  }
  save(input: any) {
    return this.serialize(async () => {
      need(
        input &&
          Object.keys(input).every((key) =>
            ["version", "accounts", "bindings", "secrets"].includes(key),
          ),
        "invalid_request",
      );
      const original = await readFile(this.path, "utf8");
      need(
        input.version === this.version && this.version === digest(original),
        "conflict",
      );
      need(
        Array.isArray(input.accounts) && Array.isArray(input.bindings),
        "invalid_request",
      );
      const raw = parse(original);
      const nextRaw = {
        ...raw,
        accounts: input.accounts,
        bindings: input.bindings,
      };
      const next = resolveConfigPaths(
        parseConfig(nextRaw),
        dirname(resolve(this.path)),
      );
      this.validate(next);
      const secrets = input.secrets ?? [];
      need(Array.isArray(secrets) && secrets.length <= 100, "invalid_request");
      for (const s of secrets) {
        need(
          typeof s.value === "string" &&
            s.value.length > 0 &&
            s.value.length <= 16384,
          "invalid_request",
        );
        need(
          s.kind === "platform"
            ? next.accounts.some(
                (a) => a.id === s.account && a.credential === s.ref,
              )
            : s.kind === "receiver" &&
                next.bindings.some(
                  (b) => b.id === s.account && b.receiver_credential === s.ref,
                ),
          "invalid_request",
        );
      }
      for (const [ref, account, kind] of [
        ...next.accounts.map((a) => [a.credential, a.id, "platform"]),
        ...next.bindings.map((b) => [b.receiver_credential, b.id, "receiver"]),
      ]) {
        if (
          !secrets.some(
            (s) => s.ref === ref && s.account === account && s.kind === kind,
          )
        )
          await this.store.secret(ref, account, kind);
      }
      const vault = this.store.db.prepare("SELECT * FROM vault").all();
      const previous = this.config;
      const replacement = stringify(nextRaw);
      this.state = "applying";
      try {
        await this.app.stop(false);
      } catch {
        this.state = "failed";
        return {
          saved: false,
          applied: false,
          state: this.state,
          version: this.version,
        };
      }
      try {
        need(!this.closed, "unavailable");
        this.store.transaction(() => {
          for (const s of secrets)
            this.store.putSecret(s.ref, s.account, s.kind, s.value);
        });
        await atomicPrivate(this.path, replacement);
        this.store.config = next;
        this.app = new Application(next, this.fixture, this.store);
        await this.app.start();
        this.config = next;
        this.version = digest(replacement);
        this.state = "applied";
        return { saved: true, applied: true, ...(await this.view()) };
      } catch {
        this.state = "failed";
        try {
          await this.app.stop(false);
          this.store.transaction((db) => {
            db.prepare("DELETE FROM vault").run();
            const insert = db.prepare(
              "INSERT INTO vault(ref,account,kind,key_id,nonce,tag,cipher) VALUES (?,?,?,?,?,?,?)",
            );
            for (const r of vault)
              insert.run(
                r.ref,
                r.account,
                r.kind,
                r.key_id,
                r.nonce,
                r.tag,
                r.cipher,
              );
          });
          await atomicPrivate(this.path, original);
          this.store.config = previous;
          this.app = new Application(previous, this.fixture, this.store);
          if (!this.closed) await this.app.start();
          this.state = "failed_recovered";
        } catch {
          await this.app.stop(false).catch(() => {});
        }
        this.version = digest(await readFile(this.path, "utf8"));
        return {
          saved: this.version === digest(replacement),
          applied: false,
          state: this.state,
          version: this.version,
        };
      }
    });
  }
  async stop() {
    this.closed = true;
    await this.app?.stop(false);
    await this.starting?.catch(() => {});
    await this.pending;
    await this.app?.stop(false);
    await this.store?.close();
  }
}
