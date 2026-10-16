import { open, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import type { Context } from "koishi";
import type { Store } from "./store";
/** Offline only: the same native Auth user table, under Post's exclusive owner. */
export async function provisionAdmin(store: Store, destination: string) {
  const db = store.db as unknown as Context["database"];
  db.extend("user", {
    password: "string(255)",
    config: { type: "json", length: 65535, initial: null },
  });
  const [existing] = await db.get("user", { id: 0 });
  if (existing) return { created: false };
  const path = resolve(destination);
  const parent = await stat(dirname(path));
  if (!parent.isDirectory() || parent.mode & 0o077)
    throw new Error("Private bootstrap parent required");
  const password = randomBytes(32).toString("base64url");
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(`Username: admin\nPassword: ${password}\n`);
    await file.sync();
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    await db.create("user", {
      id: 0,
      name: "admin",
      authority: 5,
      password: createHash("sha256").update(password).digest("hex"),
      createdAt: new Date(),
    });
  } catch (error) {
    await unlink(path);
    throw error;
  } finally {
    await file.close();
  }
  return { created: true, bootstrap_file: path };
}
