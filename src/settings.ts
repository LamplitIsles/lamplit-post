import { readFile } from "node:fs/promises";
import { parse, stringify } from "smol-toml";
import {
  parseConfig,
  resolveConfigPaths,
  privateFile,
  type Config,
  type AccountConfig,
  accountOwner,
} from "./config";
import { dirname, resolve } from "node:path";
import { Application } from "./runtime";
import type { TransportFixture } from "./host";
import { Store, digest } from "./store";
import { Fault, need } from "./errors";
import { atomicPrivate } from "./admin";
export class Settings {
  app!: Application;
  store!: Store;
  pending: Promise<unknown> = Promise.resolve();
  closed = false;
  retireManagement?: () => Promise<void>;
  private mutating = false;
  private operation = 0;
  private stageStarted = performance.now();
  phase = "idle";
  acceptedVersion: string | null = null;
  private currentKnown = true;
  private acceptedDurable = false;
  activeVersion: string | null = null;
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
      this.acceptedVersion = this.version;
      this.acceptedDurable = true;
      this.store = await Store.open(this.config);
      this.app = new Application(this.config, this.fixture, this.store);
      try {
        this.validate(this.config);
        for (const a of this.config.accounts)
          await this.store.secret(a.credential, a.id, "platform");
        for (const b of this.config.agents)
          await this.store.secret(b.receiver_credential, b.id, "receiver");
        need(!this.closed, "unavailable");
        await this.connect(this.app);
        need(!this.closed, "unavailable");
        this.activeVersion = this.version;
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
    if (this.closed || this.mutating)
      return Promise.reject(
        new Fault(this.closed ? "unavailable" : "conflict"),
      );
    this.mutating = true;
    const result = Promise.resolve().then(work);
    this.pending = result
      .catch(() => {})
      .finally(() => {
        this.mutating = false;
      });
    return result;
  }
  status() {
    const ready =
      !!this.app?.http &&
      !!this.app.service &&
      !this.app.service.closed &&
      [...this.app.service.platforms.values()].every(
        (platform) => platform.ready,
      );
    return {
      ready,
      version: this.version,
      current_version: this.currentKnown ? this.version : null,
      accepted_version: this.acceptedVersion,
      active_version: this.activeVersion,
      state: this.state,
      phase: this.phase,
      busy: this.mutating,
      saved:
        this.acceptedDurable &&
        this.currentKnown &&
        this.acceptedVersion === this.version,
      applied:
        this.state === "applied" &&
        ready &&
        this.acceptedVersion !== null &&
        this.activeVersion === this.acceptedVersion,
    };
  }
  private stage(phase: string, outcome = "pending") {
    console.info(
      JSON.stringify({
        event: "settings_stage",
        operation: this.operation,
        version: this.version,
        stage: this.phase,
        elapsed_ms: Math.round(performance.now() - this.stageStarted),
        outcome,
      }),
    );
    this.phase = phase;
    this.stageStarted = performance.now();
  }
  private async drain(app: Application) {
    this.activeVersion = null;
    const timer = setTimeout(() => {
      this.state = "failed_draining";
      this.stage("draining", "overrun");
    }, this.config.timeout_ms + 1000);
    try {
      await app.stop(false);
    } finally {
      clearTimeout(timer);
    }
  }
  private async connect(app: Application) {
    let timer: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        app.start(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void app.stop(false).catch(() => {});
            reject(new Fault("unavailable"));
          }, this.config.timeout_ms);
        }),
      ]);
      need(!this.closed, "unavailable");
    } finally {
      clearTimeout(timer!);
    }
  }
  async view() {
    need(this.currentKnown, "unavailable");
    const text = await readFile(this.path, "utf8");
    need(digest(text) === this.version, "conflict");
    const credential = (ref: string, account: string, kind: string) =>
      !!this.store.db
        .prepare("SELECT ref FROM vault WHERE ref=? AND account=? AND kind=?")
        .get(ref, account, kind);
    return {
      ...this.status(),
      error: this.state === "failed" ? "unavailable" : null,
      machine_url: this.app.http?.url ?? null,
      accounts: this.config.accounts.map((a) => ({
        ...a,
        hasCredential: credential(a.credential, a.id, "platform"),
        ready: this.app.service?.platforms.get(a.id)?.ready ?? false,
      })),
      agents: this.config.agents.map((b) => ({
        ...b,
        hasCredential: credential(b.receiver_credential, b.id, "receiver"),
        hasToken: this.store.tokens.has(b.id),
      })),
      bindings: this.config.bindings.map((b) => ({
        ...b,
        scopes: b.scopes.map((s) => ({
          ...s,
          name:
            this.store.db
              .prepare(
                "SELECT name FROM conversations WHERE account=? AND id=?",
              )
              .get(s.account_id, s.conversation_id)?.name ?? null,
        })),
      })),
    };
  }
  verifiedDraftId(platform: "matrix" | "qq", native: string, proposed: string) {
    need(!this.closed && !this.mutating, "conflict");
    const configured = this.config.accounts.find(
      (a) => a.platform === platform && a.native_id === native,
    );
    need(!configured || configured.id === proposed, "conflict");
    const claimed = this.store.db
      .prepare("SELECT platform,native FROM identities WHERE account=?")
      .get(proposed);
    need(
      !claimed || (claimed.platform === platform && claimed.native === native),
      "conflict",
    );
    const pin = this.store.db
      .prepare("SELECT account FROM identities WHERE platform=? AND native=?")
      .get(platform, native);
    // Reuse this identity's original ID only when it is absent from the current config.
    return pin && !this.config.accounts.some((a) => a.id === pin.account)
      ? String(pin.account)
      : proposed;
  }
  validate(next: Config) {
    for (const key of Object.keys(this.config).filter(
      (k) => !["accounts", "agents", "bindings"].includes(k),
    ) as (keyof Config)[])
      need(
        JSON.stringify(next[key]) === JSON.stringify(this.config[key]),
        "invalid_request",
      );
    for (const a of next.accounts) {
      this.validateAccount(a);
      if (this.config.accounts.some((old) => old.id === a.id))
        need(
          accountOwner(next, a.id) === accountOwner(this.config, a.id),
          "conflict",
        );
    }
    for (const b of next.bindings) {
      const old = this.config.bindings.find((o) => o.id === b.id);
      if (old) need(old.agent_id === b.agent_id, "conflict");
    }
    for (const a of next.agents) {
      const old = this.config.agents.find((o) => o.id === a.id);
      if (old)
        need(old.receiver_credential === a.receiver_credential, "conflict");
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
  /** Draft verification checks identity, never creates ownership or admission. */
  validateAccount(a: AccountConfig) {
    need(
      !this.config.accounts.some(
        (other) =>
          other.id !== a.id &&
          ((other.platform === a.platform && other.native_id === a.native_id) ||
            other.credential === a.credential),
      ) &&
        !this.config.agents.some(
          (agent) => agent.receiver_credential === a.credential,
        ) &&
        a.credential !== "__keycheck",
      "conflict",
    );
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
  save(input: any): Promise<ReturnType<Settings["status"]>> {
    let acknowledge!: (value: ReturnType<Settings["status"]>) => void;
    let reject!: (reason: unknown) => void;
    const response = new Promise<ReturnType<Settings["status"]>>((yes, no) => {
      acknowledge = yes;
      reject = no;
    });
    void this.serialize(async () => {
      need(this.currentKnown, "unavailable");
      this.operation++;
      this.stage("validating");
      need(
        input &&
          Object.keys(input).every((key) =>
            [
              "version",
              "accounts",
              "agents",
              "bindings",
              "secrets",
              "conversation_names",
            ].includes(key),
          ),
        "invalid_request",
      );
      const original = await readFile(this.path, "utf8");
      need(
        input.version === this.version && this.version === digest(original),
        "conflict",
      );
      need(
        Array.isArray(input.accounts) &&
          Array.isArray(input.agents) &&
          Array.isArray(input.bindings),
        "invalid_request",
      );
      const raw = parse(original);
      const nextRaw = {
        ...raw,
        accounts: input.accounts,
        agents: input.agents,
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
                next.agents.some(
                  (b) => b.id === s.account && b.receiver_credential === s.ref,
                ),
          "invalid_request",
        );
      }
      for (const [ref, account, kind] of [
        ...next.accounts.map((a) => [a.credential, a.id, "platform"]),
        ...next.agents.map((b) => [b.receiver_credential, b.id, "receiver"]),
      ]) {
        if (
          !secrets.some(
            (s) => s.ref === ref && s.account === account && s.kind === kind,
          )
        )
          await this.store.secret(ref, account, kind);
      }
      for (const account of next.accounts)
        if (!this.config.accounts.some((a) => a.id === account.id))
          need(
            secrets.some(
              (s) =>
                s.account === account.id &&
                s.ref === account.credential &&
                s.kind === "platform",
            ),
            "invalid_request",
          );
      const names = input.conversation_names ?? [];
      need(Array.isArray(names) && names.length <= 1000, "invalid_request");
      for (const n of names)
        need(
          typeof n.name === "string" &&
            n.name.trim().length > 0 &&
            n.name.length <= 256 &&
            next.bindings.some((b) =>
              b.scopes.some(
                (s) =>
                  s.account_id === n.account_id &&
                  s.conversation_id === n.conversation_id,
              ),
            ),
          "invalid_request",
        );
      const vault = this.store.db.prepare("SELECT * FROM vault").all();
      const previous = this.config;
      const replacement = stringify(nextRaw);
      this.acceptedDurable = false;
      this.acceptedVersion = null;
      this.state = "draining";
      this.stage("draining", "validated");
      const retired = this.drain(this.app);
      let timer: ReturnType<typeof setTimeout>;
      const prompt = await Promise.race([
        retired.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(
            () => resolve(false),
            Math.min(400, this.config.timeout_ms + 1000),
          );
        }),
      ]).finally(() => clearTimeout(timer!));
      if (!prompt) {
        // No late accepted mutation: this attempt only retires/reopens the unchanged runtime.
        acknowledge({ ...this.status(), saved: false, applied: false });
        await retired;
        if (!this.closed) {
          this.state = "recovering";
          this.stage("reconnecting", "unsaved_busy");
          this.app = new Application(previous, this.fixture, this.store);
          try {
            await this.connect(this.app);
            this.activeVersion = this.version;
            this.state = "failed_recovered";
          } catch {
            await this.drain(this.app);
            this.state = "failed";
          }
        }
        this.stage("idle", this.state);
        return;
      }
      try {
        need(!this.closed, "unavailable");
        this.stage("persisting", "retired");
        this.store.transaction(() => {
          for (const s of secrets)
            this.store.putSecret(s.ref, s.account, s.kind, s.value);
          for (const n of names) {
            const scope = next.bindings
              .flatMap((b) => b.scopes)
              .find(
                (s) =>
                  s.account_id === n.account_id &&
                  s.conversation_id === n.conversation_id,
              )!;
            this.store.db
              .prepare(
                "INSERT INTO conversations(id,account,native,type,name) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name",
              )
              .run(
                scope.conversation_id,
                scope.account_id,
                scope.native_id,
                scope.type,
                n.name,
              );
          }
        });
        await atomicPrivate(this.path, replacement);
        this.config = next;
        this.store.config = next;
        this.version = digest(replacement);
        this.acceptedVersion = this.version;
        this.acceptedDurable = true;
        this.state = "applying";
        this.stage("connecting", "durable_saved");
        acknowledge({ ...this.status(), saved: true, applied: false });
        this.app = new Application(next, this.fixture, this.store);
        await this.connect(this.app);
        this.activeVersion = this.version;
        this.state = "applied";
        this.stage("idle", "applied");
      } catch {
        this.state = "recovering";
        try {
          this.stage("draining", "apply_failed");
          await this.drain(this.app);
          this.stage("restoring", "retired");
          // TOML hashes exclude vault changes: restoring prior credentials retires
          // this save even when the TOML bytes are identical.
          this.acceptedDurable = false;
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
          this.config = previous;
          this.store.config = previous;
          this.version = digest(original);
          this.app = new Application(previous, this.fixture, this.store);
          if (!this.closed) {
            this.stage("reconnecting", "restored");
            await this.connect(this.app);
            this.activeVersion = this.version;
          }
          this.state = "failed_recovered";
        } catch {
          await this.drain(this.app).catch(() => {});
          this.state = "failed";
        }
        try {
          const durable = await readFile(this.path, "utf8");
          this.version = digest(durable);
          if (durable === replacement) this.config = next;
          else if (durable === original) this.config = previous;
          else this.currentKnown = false;
          this.store.config = this.config;
        } catch {
          this.currentKnown = false;
        }
        this.stage("idle", this.state);
        acknowledge({ ...this.status(), saved: false, applied: false });
      }
    }).catch((error) => {
      this.state = this.app?.service?.closed ? "failed" : this.state;
      this.stage("idle", "rejected");
      reject(error);
    });
    return response;
  }
  async stop() {
    this.closed = true;
    const managementStopped = this.retireManagement?.();
    await this.app?.stop(false);
    await this.starting?.catch(() => {});
    await managementStopped;
    await this.pending;
    await this.app?.stop(false);
    await this.store?.close();
  }
}
