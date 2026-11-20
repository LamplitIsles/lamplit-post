// Framed RPC and persistent lock adapted from keet-for-agent f6e8c57c (Apache-2.0).
// The 4.26.4 ABI and bounded cancellation/retirement are specific to Post.
import { spawn, type ChildProcess } from "node:child_process";
import { access, open, type FileHandle } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { tryLock, unlock } from "fs-native-extensions";
import RPC from "tiny-buffer-rpc";
import codec from "tiny-buffer-rpc/any.js";

const methods = [
  0, 1, 6, 19, 22, 25, 28, 39, 43, 66, 105, 141, 142, 145, 158, 160, 163, 165,
  185, 199, 243,
] as const;
// The largest configured asset is 64 MiB; leave room for RPC/file metadata.
const maxFrame = 68 * 1024 * 1024;
const barePath = "node_modules/bare-sidecar/prebuilds/linux-x64/bare";
const addonNames = [
  "bare-bluetooth-linux",
  "bare-buffer",
  "bare-crypto",
  "bare-dns",
  "bare-fs",
  "bare-hrtime",
  "bare-inspect",
  "bare-inspector",
  "bare-logger",
  "bare-os",
  "bare-path",
  "bare-pipe",
  "bare-system-logger",
  "bare-tcp",
  "bare-tls",
  "bare-type",
  "bare-url",
  "fs-native-extensions",
  "quickbit-native",
  "rocksdb-native",
  "simdle-native",
  "sodium-native",
  "udx-native",
];
const official = {
  bare: "1bfdfbc3a35280a290f0e1172bc03eb1ff9287b9483649b9da9de3b3c2225a14",
  bundle: "a20f0d1945c40fcc29f37a45d9967c86cd129e730a19fbe726b7c67b613840d3",
  addons: addonNames.map(
    (name) => `node_modules/${name}/prebuilds/linux-x64/${name}.bare`,
  ),
};
export type RuntimeHashes = typeof official;
async function sha256(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export class KeetSidecar {
  private child?: ChildProcess;
  private lock?: FileHandle;
  private rpc?: RPC;
  private calls = new Map<number, ReturnType<RPC["register"]>>();
  private streams = new Set<Duplex>();
  private startTask?: Promise<void>;
  private stopTask?: Promise<void>;
  private stopped = false;
  private ready = false;
  private pending = 0;
  private onWrite?: () => void;
  get active() {
    return this.ready && !this.stopped;
  }
  constructor(
    readonly runtime: string,
    readonly identity: string,
    readonly timeout: number,
    readonly swarming = true,
    private readonly hashes: RuntimeHashes = official,
  ) {}

  start() {
    return (this.startTask ??= this.open().catch(async () => {
      await this.stop();
      throw new Error("Keet runtime unavailable");
    }));
  }
  private async open() {
    if (process.platform !== "linux" || process.arch !== "x64" || this.stopped)
      throw new Error("unavailable");
    const [bare, bundle] = await Promise.all([
      sha256(join(this.runtime, barePath)),
      sha256(join(this.runtime, "core-worker.bundle")),
      ...this.hashes.addons.map((path) => access(join(this.runtime, path))),
    ]);
    if (
      bare !== this.hashes.bare ||
      bundle !== this.hashes.bundle ||
      this.stopped
    )
      throw new Error("runtime");
    const lock = await open(
      join(this.identity, ".keet-sidecar.lock"),
      "a+",
      0o600,
    );
    if (this.stopped) {
      await lock.close();
      throw new Error("stopped");
    }
    if (!tryLock(lock.fd)) {
      await lock.close();
      throw new Error("owned");
    }
    this.lock = lock;
    await lock.chmod(0o600);
    if (this.stopped) throw new Error("stopped");
    const child = spawn(
      join(this.runtime, barePath),
      [
        join(this.runtime, "core-worker.bundle"),
        this.identity,
        "false",
        "false",
        String(this.swarming),
        "undefined",
        "undefined",
        "info",
        "false",
        "production",
        "4.26.3",
      ],
      { stdio: ["ignore", "pipe", "pipe", "pipe"] },
    );
    this.child = child;
    const ipc = child.stdio[3] as Duplex;
    ipc.on("error", () => {
      void this.stop();
    });
    ipc.on("close", () => {
      if (this.ready) void this.stop();
    });
    child.on("error", () => {
      void this.stop();
    });
    child.on("exit", () => {
      if (this.ready) void this.stop();
    });
    child.stderr!.resume();
    const rpc = new RPC((message) => {
      if (
        message.length > maxFrame ||
        ipc.destroyed ||
        ipc.writableLength > maxFrame
      ) {
        void this.stop();
        throw new Error("Keet IPC unavailable");
      }
      const frame = Buffer.allocUnsafe(message.length + 4);
      frame.writeUInt32LE(message.length);
      message.copy(frame, 4);
      ipc.write(frame);
      this.onWrite?.();
    });
    this.rpc = rpc;
    for (const id of methods)
      this.calls.set(id, rpc.register(id, { request: codec, response: codec }));
    let incoming = Buffer.alloc(0);
    ipc.on("data", (chunk: Buffer) => {
      try {
        if (incoming.length + chunk.length > maxFrame + 4)
          throw new Error("capacity");
        incoming = Buffer.concat([incoming, chunk]);
        while (incoming.length >= 4) {
          const length = incoming.readUInt32LE(0);
          if (length > maxFrame) throw new Error("capacity");
          if (incoming.length < length + 4) break;
          rpc.recv(incoming.subarray(4, length + 4));
          incoming = incoming.subarray(length + 4);
        }
      } catch {
        void this.stop();
      }
    });
    const started = new Promise<void>((resolve, reject) => {
      let output = "";
      const exited = () => reject(new Error("unavailable"));
      child.once("exit", exited);
      child.once("error", exited);
      child.stdout!.on("data", (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-4096);
        if (output.includes("Keet core worker started")) resolve();
      });
    });
    await this.bounded(started);
    await this.request(0, []);
    const version: any = await this.request(1, []);
    if (
      version?.modules?.["keet-core"] !== "4.26.4" ||
      version?.buildType !== "Production" ||
      version?.abi?.min !== 40 ||
      version?.abi?.max !== 40 ||
      version?.abi?.autoupgrade !== 37
    )
      throw new Error("version");
    await this.request(243, []);
    if (this.stopped) throw new Error("stopped");
    this.ready = true;
  }
  private async bounded<T>(promise: Promise<T>): Promise<T> {
    const deadline = AbortSignal.timeout(this.timeout);
    let aborted: (() => void) | undefined;
    const failure = new Promise<never>((_, reject) => {
      aborted = () => {
        void this.stop();
        reject(new Error("Keet runtime unavailable"));
      };
      if (deadline.aborted) aborted();
      else deadline.addEventListener("abort", aborted, { once: true });
    });
    try {
      return await Promise.race([promise, failure]);
    } finally {
      if (aborted) deadline.removeEventListener("abort", aborted);
    }
  }
  private async request(
    id: number,
    args: unknown[],
    signal?: AbortSignal,
    onDispatch?: () => void,
  ) {
    const method = this.calls.get(id);
    if (!method || this.stopped || this.pending >= 64)
      throw new Error("Keet runtime unavailable");
    signal?.throwIfAborted();
    this.pending++;
    let owned: Promise<unknown> | undefined;
    try {
      this.onWrite = onDispatch;
      let pending: Promise<unknown>;
      try {
        pending = method.request(args);
      } finally {
        this.onWrite = undefined;
      }
      owned = this.bounded(pending).finally(() => {
        this.pending--;
      });
      void owned.catch(() => {});
      if (!signal) return await owned;
      let cancel: (() => void) | undefined;
      const cancelled = new Promise<never>((_, reject) => {
        cancel = () => reject(new Error("Keet operation cancelled"));
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
      });
      try {
        return await Promise.race([owned, cancelled]);
      } finally {
        if (cancel) signal.removeEventListener("abort", cancel);
      }
    } catch {
      throw new Error("Keet runtime unavailable");
    } finally {
      if (!owned) this.pending--;
    }
  }
  call(
    id: number,
    args: unknown[],
    signal?: AbortSignal,
    onDispatch?: () => void,
  ) {
    if (!this.ready) throw new Error("Keet runtime unavailable");
    return this.request(id, args, signal, onDispatch);
  }
  stream(id: number, args: unknown[], finite = false) {
    const method = this.calls.get(id);
    if (!this.ready || !method || this.streams.size >= 512)
      throw new Error("Keet runtime unavailable");
    const stream = method.createRequestStream();
    this.streams.add(stream);
    stream.once("close", () => this.streams.delete(stream));
    stream.on("error", () => {});
    stream.write(args);
    if (finite) stream.end();
    return stream;
  }
  stop(): Promise<void> {
    this.stopped = true;
    return (this.stopTask ??= this.close());
  }
  private async close() {
    this.ready = false;
    for (const stream of this.streams) stream.destroy();
    this.streams.clear();
    this.rpc?.destroy();
    this.rpc = undefined;
    this.calls.clear();
    const child = this.child;
    if (child) {
      const exited = new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once("close", () => resolve());
      });
      (child.stdio[3] as Duplex | null)?.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
      await exited;
      clearTimeout(timer);
    }
    // open() checks stopped after every await before creating a child.
    const lock = this.lock;
    this.lock = undefined;
    if (lock) {
      try {
        unlock(lock.fd);
      } finally {
        await lock.close();
      }
    }
  }
}
