import { open, rename, unlink, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileTypeFromBuffer } from "file-type";
import type { AssetV1 } from "../contracts/v1/index";
import { Store, opaque } from "./store";
import { Fault, need } from "./errors";
export class Assets {
  constructor(public store: Store) {}
  path(storage: string) {
    need(/^ast_[A-Za-z0-9_-]+$/.test(storage), "invalid_request");
    return join(this.store.config.data_dir, "assets", storage);
  }
  row(id: string) {
    return this.store.db.query("SELECT * FROM assets WHERE id=?").get(id) as {
      id: string;
      owner: string | null;
      metadata: string;
      storage: string | null;
    } | null;
  }
  metadata(id: string): AssetV1 {
    const r = this.row(id);
    need(r);
    return JSON.parse(r.metadata);
  }
  async validateImage(mime: string, bytes: Uint8Array) {
    need(
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime),
      "invalid_request",
    );
    const detected = await fileTypeFromBuffer(bytes.subarray(0, 8192)).catch(
      () => undefined,
    );
    need(detected?.mime === mime, "invalid_request");
  }
  async ingest(
    stream: ReadableStream<Uint8Array> | null,
    mime: string,
    name: string,
    owner: string | null,
    signal: AbortSignal,
  ) {
    need(stream, "invalid_request");
    need(
      /^[\w.+-]+\/[\w.+-]+$/.test(mime) && !mime.startsWith("multipart/"),
      "invalid_request",
    );
    const id = opaque("ast"),
      temp = this.path(id) + ".tmp",
      file = await open(temp, "wx", 0o600),
      reader = stream.getReader();
    let size = 0;
    let prefix = Buffer.alloc(0);
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        size += value.length;
        if (size > this.store.config.max_asset_bytes)
          throw new Fault("capacity");
        if (prefix.length < 8192)
          prefix = Buffer.concat([
            prefix,
            Buffer.from(value).subarray(0, 8192 - prefix.length),
          ]);
        await file.write(value);
      }
      need(size > 0, "invalid_request");
      const detected = await fileTypeFromBuffer(prefix).catch(() => undefined);
      if (mime.startsWith("image/")) await this.validateImage(mime, prefix);
      if (detected)
        need(
          mime === "application/octet-stream" || detected.mime === mime,
          "invalid_request",
        );
      await file.sync();
      await file.close();
      signal.throwIfAborted();
      await rename(temp, this.path(id));
      const directory = await open(dirname(this.path(id)), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      const meta: AssetV1 = {
        asset_id: id,
        status: "available",
        mime,
        name:
          name.replace(/[\x00-\x1f/\\]/g, "_").slice(0, 255) || "attachment",
        size,
        download_path: "/assets/" + id,
      };
      try {
        this.store.db.run("INSERT INTO assets VALUES (?,?,?,?)", [
          id,
          owner,
          JSON.stringify(meta),
          id,
        ]);
      } catch (e) {
        await unlink(this.path(id));
        throw e;
      }
      return meta;
    } catch (e) {
      await file.close().catch(() => {});
      await unlink(temp).catch(() => {});
      throw e;
    } finally {
      signal.removeEventListener("abort", cancel);
      await reader.cancel().catch(() => {});
    }
  }
  unavailable(mime: string, name: string, reason: string) {
    const id = opaque("ast");
    const meta: AssetV1 = {
      asset_id: id,
      status: "unavailable",
      mime,
      name,
      size: null,
      download_path: null,
      reason,
    };
    this.store.db.run("INSERT INTO assets VALUES (?,?,?,?)", [
      id,
      null,
      JSON.stringify(meta),
      null,
    ]);
    return meta;
  }
  async bytes(id: string, signal?: AbortSignal) {
    const r = this.row(id);
    need(r?.storage, "unavailable");
    return readFile(this.path(r.storage), { signal });
  }
}
