import { Database } from "bun:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  statSync,
  openSync,
  closeSync,
  unlinkSync,
  chmodSync,
  writeSync,
  existsSync,
  readdirSync,
  fsyncSync,
  linkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import type { Config } from "./config";
import { Fault, need } from "./errors";
export const opaque = (prefix: string) =>
  prefix + "_" + randomBytes(18).toString("base64url");
export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export class Store {
  db!: Database;
  key!: Buffer;
  lock: string;
  closed = false;
  constructor(public config: Config) {
    mkdirSync(config.data_dir, { recursive: true, mode: 0o700 });
    need(!(statSync(config.data_dir).mode & 0o077), "invalid_request");
    this.lock = join(config.data_dir, "owner.lock");
    this.acquireLock();
    try {
      this.initializeKey();
      this.db = new Database(join(config.data_dir, "post.sqlite"), {
        create: true,
      });
      chmodSync(join(config.data_dir, "post.sqlite"), 0o600);
      this.db
        .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;
   CREATE TABLE IF NOT EXISTS meta(version INTEGER NOT NULL); INSERT INTO meta SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM meta);
   CREATE TABLE IF NOT EXISTS vault(ref TEXT PRIMARY KEY,account TEXT,kind TEXT,key_id TEXT,nonce BLOB,tag BLOB,cipher BLOB);
   CREATE TABLE IF NOT EXISTS tokens(agent TEXT PRIMARY KEY,digest TEXT UNIQUE NOT NULL);
   CREATE TABLE IF NOT EXISTS identities(account TEXT PRIMARY KEY,platform TEXT,native TEXT);
   CREATE TABLE IF NOT EXISTS conversations(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,account TEXT,native TEXT,type TEXT,name TEXT,UNIQUE(account,native,type));
   CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,account TEXT,conversation TEXT,native TEXT,sender TEXT,body TEXT,UNIQUE(account,conversation,native));
   CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,owner TEXT,metadata TEXT NOT NULL,storage TEXT);
   CREATE TABLE IF NOT EXISTS message_assets(asset TEXT,message TEXT,PRIMARY KEY(asset,message));
   CREATE INDEX IF NOT EXISTS message_scope ON messages(account,conversation,seq);
   CREATE TABLE IF NOT EXISTS deliveries(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,binding TEXT,agent TEXT,message TEXT,receiver TEXT,body TEXT,state TEXT DEFAULT 'pending',attempt INTEGER DEFAULT 0,due INTEGER DEFAULT 0,category TEXT);
   CREATE INDEX IF NOT EXISTS delivery_work ON deliveries(binding,state,seq);
   CREATE TABLE IF NOT EXISTS sends(agent TEXT,request TEXT,input TEXT,result TEXT,PRIMARY KEY(agent,request));
   CREATE TABLE IF NOT EXISTS reply_sequences(account TEXT, native TEXT, sequence INTEGER, PRIMARY KEY(account,native));
   CREATE TABLE IF NOT EXISTS gaps(seq INTEGER PRIMARY KEY AUTOINCREMENT,account TEXT,category TEXT,at INTEGER);
  `);
      need(
        (this.db.query("SELECT version FROM meta").get() as any).version === 1,
        "invalid_request",
      );
      this.db.run(
        `UPDATE sends SET result=json_object('request_id',request,'status','unknown','parts',json('[]'),'stored',json('false')) WHERE result IS NULL`,
      );
      const check = this.db
        .query("SELECT 1 FROM vault WHERE ref=?")
        .get("__keycheck");
      if (check)
        need(
          this.secret("__keycheck", "__post", "key_check") === "post-v1",
          "unavailable",
        );
      else this.putSecret("__keycheck", "__post", "key_check", "post-v1");
      mkdirSync(join(config.data_dir, "assets"), {
        mode: 0o700,
        recursive: true,
      });
    } catch (e) {
      this.db!?.close();
      unlinkSync(this.lock);
      throw e;
    }
  }
  private acquireLock() {
    // Serialize stale-owner inspection so one recovery cannot unlink a new owner.
    const guard = this.lock + ".recovering";
    let guarding = false;
    try {
      if (existsSync(this.lock)) {
        const fd = openSync(guard, "wx", 0o600);
        closeSync(fd);
        guarding = true;
        const prior = JSON.parse(readFileSync(this.lock, "utf8"));
        need(Number.isInteger(prior.pid) && prior.pid > 0, "conflict");
        try {
          process.kill(prior.pid, 0);
          throw new Fault("conflict");
        } catch (e) {
          if ((e as any).code !== "ESRCH") throw e;
        }
        unlinkSync(this.lock);
      }
      const fd = openSync(this.lock, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid }));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      throw new Fault(
        "conflict",
        "Data directory locked; inspect owner before offline recovery",
      );
    } finally {
      if (guarding) unlinkSync(guard);
    }
  }
  private initializeKey() {
    // Any existing DB/WAL counts as state; losing its key never starts a new vault.
    const existing = readdirSync(this.config.data_dir).some(
      (name) => name !== "owner.lock",
    );
    const path = this.config.master_key_file;
    need(
      path !== this.config.data_dir &&
        !path.startsWith(this.config.data_dir + "/"),
      "invalid_request",
    );
    if (!existsSync(path)) {
      need(!existing, "unavailable");
      const parent = dirname(path);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      need(!(statSync(parent).mode & 0o077), "invalid_request");
      const candidate = path + "." + opaque("initializing");
      let fd: number | undefined;
      try {
        fd = openSync(candidate, "wx", 0o600);
        writeSync(fd, randomBytes(32));
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        // Hard-link publication is atomic and refuses an existing winner.
        try {
          linkSync(candidate, path);
        } catch (e) {
          if ((e as any).code !== "EEXIST") throw e;
        }
        const dir = openSync(parent, "r");
        try {
          fsyncSync(dir);
        } finally {
          closeSync(dir);
        }
      } finally {
        if (fd !== undefined) closeSync(fd);
        unlinkSync(candidate);
      }
    }
    const keyStat = statSync(path);
    need(keyStat.isFile() && !(keyStat.mode & 0o077), "invalid_request");
    this.key = readFileSync(path);
    need(this.key.length === 32, "invalid_request");
  }
  putSecret(ref: string, account: string, kind: string, secret: string) {
    const nonce = randomBytes(12),
      key_id = digest(this.key.toString("base64")).slice(0, 16);
    const aad = JSON.stringify([ref, account, kind, 1, key_id]);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(aad));
    const sealed = Buffer.concat([
      cipher.update(secret, "utf8"),
      cipher.final(),
    ]);
    this.db.run("INSERT OR REPLACE INTO vault VALUES (?,?,?,?,?,?,?)", [
      ref,
      account,
      kind,
      key_id,
      nonce,
      cipher.getAuthTag(),
      sealed,
    ]);
  }
  secret(ref: string, account: string, kind: string) {
    const r = this.db.query("SELECT * FROM vault WHERE ref=?").get(ref) as any;
    need(r && r.account === account && r.kind === kind, "unavailable");
    try {
      const d = createDecipheriv("aes-256-gcm", this.key, r.nonce);
      d.setAAD(Buffer.from(JSON.stringify([ref, account, kind, 1, r.key_id])));
      d.setAuthTag(r.tag);
      return Buffer.concat([d.update(r.cipher), d.final()]).toString();
    } catch {
      throw new Fault("unavailable", "Vault authentication failed");
    }
  }
  issue(agent: string) {
    need(
      this.config.bindings.some((b) => b.agent_id === agent),
      "invalid_request",
    );
    const token = randomBytes(32).toString("base64url");
    this.db.run("INSERT OR REPLACE INTO tokens VALUES (?,?)", [
      agent,
      digest(token),
    ]);
    return token;
  }
  revoke(agent: string) {
    this.db.transaction(() => {
      this.db.run("DELETE FROM tokens WHERE agent=?", [agent]);
      this.db.run(
        "UPDATE deliveries SET state='cancelled',category='agent_revoked' WHERE agent=? AND state IN ('pending','held')",
        [agent],
      );
    })();
  }
  authenticate(token: string) {
    const row = this.db
      .query("SELECT agent FROM tokens WHERE digest=?")
      .get(digest(token)) as any;
    return row && this.config.bindings.some((b) => b.agent_id === row.agent)
      ? (row.agent as string)
      : undefined;
  }
  pin(account: string, platform: string, native: string) {
    const r = this.db
      .query("SELECT * FROM identities WHERE account=?")
      .get(account) as any;
    if (r) need(r.platform === platform && r.native === native, "conflict");
    else
      this.db.run("INSERT INTO identities VALUES (?,?,?)", [
        account,
        platform,
        native,
      ]);
  }
  gap(account: string, category: string) {
    this.db.run("INSERT INTO gaps(account,category,at) VALUES (?,?,?)", [
      account,
      category,
      Date.now(),
    ]);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.close();
    this.key.fill(0);
    unlinkSync(this.lock);
  }
}
