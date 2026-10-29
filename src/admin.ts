import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

import { readFile, open, rename, unlink, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { privateFile } from "./config";

export const ADMIN_SESSION_SECONDS = 30 * 24 * 60 * 60;

export async function passwordHash(password: string, salt: string) {
  return new Promise<Buffer>((resolve, reject) =>
    scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, value) => (error ? reject(error) : resolve(value)),
    ),
  );
}
export async function atomicPrivate(path: string, contents: string) {
  const temp = path + "." + randomBytes(18).toString("hex");
  try {
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
    const dir = await open(dirname(path), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await unlink(temp).catch(() => {});
  }
}
export async function provisionAdmin(path: string, password: string) {
  const parent = await stat(dirname(path));
  if (!parent.isDirectory() || parent.mode & 0o077)
    throw new Error("Private administrator directory required");
  if (password.length < 12 || password.length > 1024)
    throw new Error("Password length");
  const salt = randomBytes(32).toString("hex");
  await atomicPrivate(
    path,
    JSON.stringify({
      salt,
      hash: (await passwordHash(password, salt)).toString("hex"),
    }),
  );
}
export class Admin {
  sessions = new Map<string, { csrf: string; expires: number }>();
  attempts: number[] = [];
  private path = "";
  private record!: { salt: string; hash: string };
  private pending: Promise<unknown> = Promise.resolve();
  async open(path: string) {
    await privateFile(path);
    const {
      salt,
      hash,
      sessions = [],
    } = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof salt !== "string" ||
      typeof hash !== "string" ||
      !Array.isArray(sessions) ||
      sessions.length > 32
    )
      throw new Error("Invalid administrator record");
    this.path = path;
    this.record = { salt, hash };
    this.sessions.clear();
    const now = Date.now();
    for (const s of sessions)
      if (
        typeof s.digest === "string" &&
        /^[a-f0-9]{64}$/.test(s.digest) &&
        typeof s.csrf === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(s.csrf) &&
        Number.isFinite(s.expires) &&
        s.expires > now &&
        s.expires <= now + ADMIN_SESSION_SECONDS * 1000
      )
        this.sessions.set(s.digest, { csrf: s.csrf, expires: s.expires });
  }
  private digest(token: string) {
    return createHash("sha256")
      .update(this.record.salt)
      .update(token)
      .digest("hex");
  }
  private serialize<T>(work: () => Promise<T>) {
    const next = this.pending.then(work);
    this.pending = next.catch(() => {});
    return next;
  }
  private persist() {
    return atomicPrivate(
      this.path,
      JSON.stringify({
        ...this.record,
        sessions: [...this.sessions].map(([digest, value]) => ({
          digest,
          ...value,
        })),
      }),
    );
  }
  async login(path: string, password: string) {
    const now = Date.now();
    this.attempts = this.attempts.filter((t) => t > now - 60000);
    if (this.attempts.length >= 5) return undefined;
    this.attempts.push(now);
    return this.serialize(async () => {
      await this.open(path);
      const record = this.record;
      const expected = Buffer.from(record.hash, "hex");
      const actual = await passwordHash(password, record.salt);
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        return undefined;
      const token = randomBytes(32).toString("base64url");
      this.session(token, {
        csrf: randomBytes(32).toString("base64url"),
        expires: now + ADMIN_SESSION_SECONDS * 1000,
      });
      await this.persist();
      return token;
    });
  }
  logout(token: string) {
    return this.serialize(async () => {
      this.sessions.delete(this.digest(token));
      await this.persist();
    });
  }
  session(token: string, value?: { csrf: string; expires: number }) {
    for (const [key, s] of this.sessions)
      if (s.expires <= Date.now()) this.sessions.delete(key);
    if (value) {
      if (this.sessions.size >= 32)
        this.sessions.delete(this.sessions.keys().next().value!);
      this.sessions.set(this.digest(token), value);
    }
    return this.sessions.get(this.digest(token));
  }
}
