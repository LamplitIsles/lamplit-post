import type { DatabaseSync } from "node:sqlite";
import type { Tables } from "./models";

/** Initialize only an empty name; the stored value is always authoritative. */
export function ensureConversationName(
  db: DatabaseSync,
  row: Pick<Tables["conversations"], "seq" | "id" | "type" | "name">,
  platform: "qq" | "matrix",
  initial?: string,
) {
  if (!row.name?.trim()) {
    const name =
      initial?.trim().slice(0, 256) ||
      `${platform === "qq" ? "QQ" : "Matrix"} ${row.type === "direct" ? "私聊" : "群聊"} ${row.seq}`;
    db.prepare(
      "UPDATE conversations SET name=? WHERE id=? AND name IS ?",
    ).run(name, row.id, row.name);
    row.name = db
      .prepare("SELECT name FROM conversations WHERE id=?")
      .get(row.id)!.name as string;
  }
  return row.name!;
}
