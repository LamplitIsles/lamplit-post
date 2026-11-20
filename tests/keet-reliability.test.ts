import { test, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  access,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { settingsFixture } from "./fixtures/settings";
import { until } from "./fixtures/state";

const hash = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

test("Keet failures isolate a healthy account and recovery retires the prior owner without replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "post-keet-recovery-"));
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
  const worker = resolve("tests/fixtures/keet-platform-worker.cjs");
  await symlink(worker, join(runtime, "core-worker.bundle"));
  const file = join(identity, "fixture.json"),
    trace = join(identity, "worker-events");
  await writeFile(join(identity, "trace-workers"), "");
  let native: any = {
    member: "member",
    displayName: "Fixture",
    fail: 6,
    rooms: {},
    invites: [],
    links: {},
  };
  const save = async () => {
    await writeFile(file + ".test", JSON.stringify(native));
    await rename(file + ".test", file);
  };
  await save();
  const hashes = {
    bare: await hash(launcher),
    bundle: await hash(worker),
    addons: [] as string[],
  };
  let f: Awaited<ReturnType<typeof settingsFixture>> | undefined;
  try {
    f = await settingsFixture(
      false,
      1500,
      undefined,
      undefined,
      undefined,
      (config) => ({
        ...config,
        keet_runtime_dir: runtime,
        accounts: [
          ...config.accounts,
          {
            id: "keet-main",
            platform: "keet",
            native_id: "member",
            identity_dir: identity,
          },
        ],
        bindings: config.bindings.map((b) => ({
          ...b,
          account_ids: [...b.account_ids, "keet-main"],
        })),
      }),
      { keet: { hashes, swarming: false }, recoveryDelayMs: 250 },
      false,
      async (store) => {
        await store.pin("keet-main", "keet", "previous-member");
      },
    );
    await f.login();
    const service = f.app.app.service!;
    const listAccounts = async () => {
      const response = await fetch(f!.app.app.http!.url + "/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + f!.state.token,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_accounts", arguments: {} },
        }),
      });
      expect(response.status).toBe(200);
      return (await response.json()).result.structuredContent.items as {
        account_id: string;
        ready: boolean;
      }[];
    };
    await until(() => service.platforms.get("matrix-main")?.ready, 5000);
    await until(
      () =>
        service.accountStates.get("keet-main")?.reason === "identity_mismatch",
      5000,
    );
    expect(service.accountStates.get("keet-main")?.state).toBe(
      "needs_attention",
    );
    await expect(access(trace)).rejects.toMatchObject({ code: "ENOENT" });
    let accounts = await listAccounts();
    expect(accounts.map((account) => account.account_id)).toEqual([
      "qq-main",
      "matrix-main",
    ]);
    service.store.db
      .prepare("UPDATE identities SET platform=? WHERE account=?")
      .run("matrix", "keet-main");
    expect(
      (await listAccounts()).some(
        (account) => account.account_id === "keet-main",
      ),
    ).toBe(false);
    service.store.db
      .prepare("DELETE FROM identities WHERE account=?")
      .run("keet-main");
    await until(
      () =>
        service.accountStates.get("keet-main")?.reason ===
          "connection_unavailable" &&
        service.accountStates.get("keet-main")?.next_retry_at != null,
      5000,
    );
    accounts = await listAccounts();
    expect(accounts.some((account) => account.account_id === "keet-main")).toBe(
      false,
    );
    await service.store.pin("keet-main", "keet", "member");
    accounts = await listAccounts();
    expect(
      accounts.find((account) => account.account_id === "keet-main"),
    ).toMatchObject({
      ready: false,
    });
    expect((await fetch(f.app.app.http!.url + "/healthz")).status).toBe(200);
    expect(f.app.status()).toMatchObject({ ready: true, applied: true });
    expect(service.accountStates.get("keet-main")).toMatchObject({
      state: "recovering",
      reason: "connection_unavailable",
    });
    f.platform.sendMatrix({
      body: "Post, healthy during Keet startup failure",
      msgtype: "m.text",
    });
    await until(
      () =>
        f!.receiver.attempts.some((s) =>
          s.includes("healthy during Keet startup failure"),
        ),
      5000,
    );
    const matrixSend = await service.call("cfl", "send_message", {
      account_id: "matrix-main",
      conversation_name: "Matrix 群聊 3",
      request_id: "healthy-matrix",
      content: [{ type: "text", text: "healthy fixture" }],
    });
    expect(matrixSend.status).toBe("sent");
    delete native.fail;
    native.member = "wrong-member";
    await save();
    await until(
      () =>
        service.accountStates.get("keet-main")?.reason === "identity_mismatch",
      5000,
    );
    expect(service.accountStates.get("keet-main")?.state).toBe(
      "needs_attention",
    );
    native.member = "member";
    await save();
    await until(() => service.platforms.get("keet-main")?.ready, 7000);
    const first = service.platforms.get("keet-main")!;
    expect(
      (await listAccounts()).find(
        (account) => account.account_id === "keet-main",
      ),
    ).toMatchObject({ ready: true });
    native = JSON.parse(await readFile(file, "utf8"));
    native.rooms.room = {
      type: "0",
      readable: true,
      writable: true,
      removed: false,
      name: "Keet fixture",
    };
    await save();
    await service.refreshKeet("keet-main", service.signal());
    native.dropSend = true;
    await save();
    const args = {
      account_id: "keet-main",
      conversation_name: "Keet fixture",
      request_id: "uncertain-before-recovery",
      content: [{ type: "text", text: "one native submission" }],
    };
    expect((await service.call("cfl", "send_message", args)).status).toBe(
      "unknown",
    );
    native = JSON.parse(await readFile(file, "utf8"));
    expect(native.sent).toHaveLength(1);
    native.dropSend = false;
    await save();
    await until(() => {
      const current = service.platforms.get("keet-main");
      return current !== first && current?.ready;
    }, 10000);
    expect((await service.call("cfl", "send_message", args)).status).toBe(
      "unknown",
    );
    expect(JSON.parse(await readFile(file, "utf8")).sent).toHaveLength(1);
    await f.close();
    f = undefined;
    const events = (await readFile(trace, "utf8")).trim().split("\n");
    const active = new Set<string>();
    let starts = 0;
    for (const event of events) {
      const [action, pid] = event.split(" ");
      if (action === "start") {
        expect(active.size).toBe(0);
        active.add(pid!);
        starts++;
      } else {
        expect(active.delete(pid!)).toBe(true);
      }
    }
    expect(starts).toBeGreaterThanOrEqual(3);
    expect(active.size).toBe(0);
  } finally {
    await f?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
