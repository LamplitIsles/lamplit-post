import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

import { readFile, open, rename, unlink, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { privateFile } from "./config";

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
  async login(path: string, password: string) {
    const now = Date.now();
    this.attempts = this.attempts.filter((t) => t > now - 60000);
    if (this.attempts.length >= 5) return undefined;
    this.attempts.push(now);
    await privateFile(path);
    const record = JSON.parse(await readFile(path, "utf8"));
    const expected = Buffer.from(record.hash, "hex");
    const actual = await passwordHash(password, record.salt);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return undefined;
    const token = randomBytes(32).toString("base64url");
    this.session(token, {
      csrf: randomBytes(32).toString("base64url"),
      expires: now + 8 * 3600000,
    });
    return token;
  }
  session(token: string, value?: { csrf: string; expires: number }) {
    for (const [key, s] of this.sessions)
      if (s.expires <= Date.now()) this.sessions.delete(key);
    if (value) {
      if (this.sessions.size >= 32)
        this.sessions.delete(this.sessions.keys().next().value!);
      this.sessions.set(token, value);
    }
    return this.sessions.get(token);
  }
}
