import { test, expect } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { KeetSidecar } from "../src/keet-sidecar";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "post-keet-test-"));
  const runtime = join(root, "runtime"),
    identity = join(root, "identity");
  await mkdir(join(runtime, "node_modules/bare-sidecar/prebuilds/linux-x64"), {
    recursive: true,
  });
  await mkdir(identity);
  const launcher = join(
    runtime,
    "node_modules/bare-sidecar/prebuilds/linux-x64/bare",
  );
  await writeFile(
    launcher,
    "#!/bin/sh\nexec '" +
      process.execPath.replaceAll("'", "'\\''") +
      '\' "$@"\n',
    { mode: 0o700 },
  );
  await symlink(
    resolve("tests/fixtures/keet-worker.cjs"),
    join(runtime, "core-worker.bundle"),
  );
  const hash = async (path: string) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  const hashes = {
    bare: await hash(launcher),
    bundle: await hash(resolve("tests/fixtures/keet-worker.cjs")),
    addons: [] as string[],
  };
  return { root, runtime, identity, hashes };
}

test("sidecar enforces identity ownership and releases it after native retirement", async () => {
  const f = await fixture();
  const first = new KeetSidecar(f.runtime, f.identity, 1000, false, f.hashes);
  const second = new KeetSidecar(f.runtime, f.identity, 1000, false, f.hashes);
  try {
    await first.start();
    expect(await first.call(6, [])).toEqual({ memberId: "test-member" });
    await expect(second.start()).rejects.toThrow("Keet runtime unavailable");
    await first.stop();
    const third = new KeetSidecar(f.runtime, f.identity, 1000, false, f.hashes);
    try {
      await third.start();
    } finally {
      await third.stop();
    }
  } finally {
    await first.stop();
    await second.stop();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("timed-out native work retires the worker and releases its lock", async () => {
  const f = await fixture();
  const sidecar = new KeetSidecar(f.runtime, f.identity, 300, false, f.hashes);
  try {
    await sidecar.start();
    await expect(sidecar.call(39, ["hang"])).rejects.toThrow(
      "Keet runtime unavailable",
    );
    await sidecar.stop();
    const next = new KeetSidecar(f.runtime, f.identity, 1000, false, f.hashes);
    try {
      await next.start();
    } finally {
      await next.stop();
    }
  } finally {
    await sidecar.stop();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("stop during startup retires the child and prevents readiness", async () => {
  const f = await fixture();
  await writeFile(join(f.identity, "delay-start"), "");
  const sidecar = new KeetSidecar(f.runtime, f.identity, 300, false, f.hashes);
  try {
    const starting = sidecar.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await sidecar.stop();
    await expect(starting).rejects.toThrow("Keet runtime unavailable");
  } finally {
    await sidecar.stop();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("caller cancellation does not submit pre-aborted RPCs or retire shared Core", async () => {
  const f = await fixture();
  const sidecar = new KeetSidecar(f.runtime, f.identity, 1000, false, f.hashes);
  try {
    await sidecar.start();
    const pre = new AbortController();
    pre.abort();
    let dispatched = 0;
    await expect(
      sidecar.call(39, ["delay"], pre.signal, () => dispatched++),
    ).rejects.toThrow();
    await expect(readFile(join(f.identity, "requests"))).rejects.toThrow();
    expect(dispatched).toBe(0);
    const abort = new AbortController();
    const pending = sidecar.call(
      39,
      ["delay"],
      abort.signal,
      () => dispatched++,
    );
    abort.abort();
    await expect(pending).rejects.toThrow();
    expect(dispatched).toBe(1);
    expect(await sidecar.call(6, [])).toEqual({ memberId: "test-member" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sidecar.active).toBe(true);
    expect(await readFile(join(f.identity, "requests"), "utf8")).toBe(
      "request\n",
    );
  } finally {
    await sidecar.stop();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("sidecar accepts a file RPC larger than 32 MiB within Post's configured limit", async () => {
  const f = await fixture();
  const sidecar = new KeetSidecar(
    f.runtime,
    f.identity,
    15000,
    false,
    f.hashes,
  );
  try {
    await sidecar.start();
    expect(
      await sidecar.call(185, [Buffer.alloc(33 * 1024 * 1024)]),
    ).toBeNull();
  } finally {
    await sidecar.stop();
    await rm(f.root, { recursive: true, force: true });
  }
}, 30000);

// Opt-in only: caller must use an isolated network namespace and a disposable profile.
test.skipIf(!process.env.POST_KEET_TEST_RUNTIME)(
  "official pinned worker boots and reads its disposable identity",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "post-keet-official-"));
    const sidecar = new KeetSidecar(
      process.env.POST_KEET_TEST_RUNTIME!,
      root,
      10000,
      false,
    );
    try {
      await sidecar.start();
      const identity = (await sidecar.call(6, [])) as { memberId: string };
      expect(identity.memberId).toHaveLength(52);
      const room = await sidecar.call(25, [
        { config: { title: "Post fixture" } },
      ]);
      const info = (await sidecar.call(39, [room])) as {
        roomId: string;
        status: { isReadable: boolean };
      };
      expect(info.roomId).toBe(room);
      expect(info.status.isReadable).toBe(true);
    } finally {
      await sidecar.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
