import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  statSync,
  readFileSync,
  readSync,
  readdirSync,
  existsSync,
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  unlinkSync,
  linkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import type { Config } from "./config";
import { Fault, need } from "./errors";

/** Exclusive local ownership is acquired before SQLite startup. */
export class Ownership {
  key!: Buffer;
  lock: string;
  closed = false;
  fresh = false;
  constructor(public config: Config) {
    mkdirSync(config.data_dir, { recursive: true, mode: 0o700 });
    need(!(statSync(config.data_dir).mode & 0o077), "invalid_request");
    this.lock = join(config.data_dir, "owner.lock");
    this.acquireLock();
    try {
      const database = join(config.data_dir, "post.sqlite");
      const state = readdirSync(config.data_dir).filter(
        (n) => n !== "owner.lock",
      );
      this.fresh = state.length === 0;
      if (!this.fresh) {
        if (!existsSync(database))
          throw new Fault("unavailable", "Incompatible state");
        const header = Buffer.alloc(100),
          fd = openSync(database, "r");
        try {
          if (readSync(fd, header, 0, 100, 0) !== 100)
            throw new Fault("unavailable", "Incompatible state");
        } finally {
          closeSync(fd);
        }
        if (
          header.subarray(0, 16).toString() !== "SQLite format 3\0" ||
          header.readUInt32BE(68) !== 0x504f5354 ||
          header.readUInt32BE(60) !== 2
        )
          throw new Fault("unavailable", "Incompatible state");
        need(!(statSync(database).mode & 0o077), "invalid_request");
      }
      this.initializeKey();
    } catch (e) {
      this.key?.fill(0);
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
      const candidate =
        path + "." + "initializing_" + randomBytes(18).toString("base64url");
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
    need(!(statSync(dirname(path)).mode & 0o077), "invalid_request");
    const keyStat = statSync(path);
    need(keyStat.isFile() && !(keyStat.mode & 0o077), "invalid_request");
    this.key = readFileSync(path);
    need(this.key.length === 32, "invalid_request");
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.key.fill(0);
    unlinkSync(this.lock);
  }
}
