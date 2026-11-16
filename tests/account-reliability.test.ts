import { test, expect, vi } from "vitest";
import { Service } from "../src/service";
import { Store } from "../src/store";
import { Application, start } from "../src/runtime";
import { stateFixture, until } from "./fixtures/state";
import { platformsFixture } from "./fixtures/platforms";
import { consumerFixture } from "./fixtures/consumer";
import type { Observation } from "../src/platform";

const event = (id: string, matrix = false): Observation => ({
  native_id: id,
  conversation_native_id: matrix ? "!room:fixture" : "qq-group",
  conversation_type: "group",
  sender: matrix ? "@owner:fixture" : "qq-owner",
  timestamp: Date.now(),
  content: [{ type: "text", text: "Post, hello" }],
  assets: [],
  mentions: [],
  self_mentioned: !matrix,
  catchup: false,
});

test("quota and delivery heads are isolated per account, with atomic rollback and immutable retry", async () => {
  const receiver = await consumerFixture(true),
    s = await stateFixture("http://127.0.0.1:1", receiver.url);
  s.config.backlog_limit = 2;
  const store = await Store.open(s.config),
    service = new Service(store);
  try {
    for (const config of s.config.accounts)
      service.platforms.set(config.id, {
        config,
        nativeUserId: config.native_id,
        ready: true,
        async start() {},
        async stop() {},
        async check() {},
        async send() {
          return ["receipt"];
        },
        async members() {
          return { items: [], capability: "unsupported" };
        },
      });
    await service.observe("qq-main", event("a1"));
    await service.observe("qq-main", event("a2"));
    await expect(service.observe("qq-main", event("a3"))).rejects.toMatchObject(
      { code: "capacity" },
    );
    await service.observe("matrix-main", event("b1", true));
    const binding = s.config.bindings[0]!;
    const rows = store.db
      .prepare(
        "SELECT d.body,m.native FROM deliveries d JOIN messages m ON m.id=d.message ORDER BY d.seq",
      )
      .all() as any[];
    expect(rows.map((r) => r.native)).toEqual(["a1", "a2", "b1"]);
    expect((await service.status()).healthy).toBe(true);
    await service.dispatch(binding, "qq-main"); // fixture rejects first attempt
    await service.dispatch(binding, "matrix-main");
    expect(receiver.attempts).toEqual([rows[0].body, rows[2].body]);
    store.db
      .prepare(
        "UPDATE deliveries SET due=0 WHERE message=(SELECT id FROM messages WHERE native='a1')",
      )
      .run();
    await service.dispatch(binding, "qq-main");
    await service.dispatch(binding, "qq-main");
    expect(receiver.attempts).toEqual([
      rows[0].body,
      rows[2].body,
      rows[0].body,
      rows[1].body,
    ]);
  } finally {
    await service.stop();
    await store.close();
    await receiver.close();
    await s.close();
  }
});

test("unavailable QQ starts independently, Matrix remains operational, QQ recovers and shutdown retires I/O", async () => {
  const p = await platformsFixture(),
    receiver = await consumerFixture(),
    s = await stateFixture(p.url, receiver.url, 500);
  p.tokenStall(true);
  const app = await start(s.config, { qqOrigin: p.url, qqGateway: p.gateway });
  try {
    await until(() => app.service.platforms.get("matrix-main")?.ready, 5000);
    expect((await fetch(app.http.url + "/healthz")).status).toBe(200);
    p.sendMatrix({ body: "Post, available", msgtype: "m.text" });
    await until(() => receiver.attempts.length > 0, 5000);
    const sent = await app.service.call("cfl", "send_message", {
      account_id: "matrix-main",
      conversation_name: "Matrix 群聊 3",
      request_id: "matrix-while-qq-offline",
      content: [{ type: "text", text: "owned response" }],
    });
    expect(sent.status).toBe("sent");
    await until(() => p.aborts > 0, 5000);
    p.tokenStall(false);
    await until(() => app.service.platforms.get("qq-main")?.ready, 10000);
    p.sendQQ("GROUP_AT_MESSAGE_CREATE", "recovered");
    await until(
      () => receiver.attempts.some((x) => x.includes("recovered")),
      5000,
    );
  } finally {
    await app.stop();
    await p.close();
    await receiver.close();
    await s.close();
  }
}, 25000);

test("all accounts unavailable leave health up; shared storage failure reports 503", async () => {
  const p = await platformsFixture(),
    s = await stateFixture("http://127.0.0.1:1", "http://127.0.0.1:2", 250);
  p.tokenStall(true);
  const app = await start(s.config, { qqOrigin: p.url, qqGateway: p.gateway });
  try {
    await until(() => app.service.accountStates.size === 2);
    expect((await fetch(app.http.url + "/healthz")).status).toBe(200);
    expect(
      [...app.service.platforms.values()].every((platform) => !platform.ready),
    ).toBe(true);
    app.store.db.exec("PRAGMA query_only=ON");
    await expect(
      app.service.observe("qq-main", event("storage-failure")),
    ).rejects.toBeDefined();
    app.store.db.exec("PRAGMA query_only=OFF");
    const failed = await fetch(app.http.url + "/healthz");
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ healthy: false });
  } finally {
    await app.stop();
    await p.close();
    await s.close();
  }
});

test("a held account head does not prevent another account delivering", async () => {
  const receiver = await consumerFixture(),
    other = await consumerFixture();
  const s = await stateFixture("http://127.0.0.1:1", receiver.url);
  const store = await Store.open(s.config),
    service = new Service(store);
  try {
    for (const config of s.config.accounts)
      service.platforms.set(config.id, {
        config,
        nativeUserId: config.native_id,
        ready: true,
        async start() {},
        async stop() {},
        async check() {},
        async send() {
          return ["receipt"];
        },
        async members() {
          return { items: [], capability: "unsupported" };
        },
      });
    await service.observe("qq-main", event("held"));
    s.config.agents[0]!.receiver_url = other.url;
    await service.observe("matrix-main", event("other", true));
    await service.dispatch(s.config.bindings[0]!, "qq-main");
    await service.dispatch(s.config.bindings[0]!, "matrix-main");
    expect(receiver.attempts).toHaveLength(0);
    expect(other.attempts).toHaveLength(1);
    expect(other.attempts[0]).toContain('"native_message_id":"other"');
    expect((await service.status()).healthy).toBe(true);
  } finally {
    await service.stop();
    await store.close();
    await receiver.close();
    await other.close();
    await s.close();
  }
});

test("authenticated management reports safe actionable account state", async () => {
  const { settingsFixture } = await import("./fixtures/settings");
  const f = await settingsFixture();
  try {
    expect((await f.request("status")).status).toBe(401);
    await f.login();
    await until(
      () =>
        f.app.app.service?.accountStates.get("qq-main")?.state === "connected",
      5000,
    );
    const response = await f.request("status");
    expect(response.status).toBe(200);
    const status = await response.json();
    expect(status.applied).toBe(true);
    expect(
      status.accounts.find((a: any) => a.account_id === "qq-main"),
    ).toMatchObject({
      state: "connected",
      reason: null,
      next_retry_at: null,
      backlog: [
        {
          binding_id: "cfl-binding",
          account_id: "qq-main",
          pending: 0,
          held: 0,
          limit: 10000,
        },
      ],
    });
    expect(JSON.stringify(status)).not.toContain("test-qq-platform-secret");
  } finally {
    await f.close();
  }
});

test("Matrix authentication rejection is safely classified and leaves QQ operational", async () => {
  const p = await platformsFixture(),
    receiver = await consumerFixture(),
    s = await stateFixture(p.url, receiver.url, 400);
  p.matrixCredential("another-credential");
  const app = await start(s.config, {
    qqOrigin: p.url,
    qqGateway: p.gateway,
    recoveryDelayMs: 500,
  });
  try {
    await until(
      () =>
        app.service.accountStates.get("matrix-main")?.state ===
        "needs_attention",
      6000,
    );
    const state = app.service.accountStates.get("matrix-main")!;
    expect(state.reason).toBe("authentication_rejected");
    expect(state.next_retry_at).toBeGreaterThan(Date.now());
    expect(JSON.stringify(state)).not.toContain("credential");
    await until(() => app.service.platforms.get("qq-main")?.ready, 5000);
    p.sendQQ("GROUP_AT_MESSAGE_CREATE", "other account working");
    await until(() => receiver.attempts.length > 0, 5000);
    expect((await fetch(app.http.url + "/healthz")).status).toBe(200);
    p.matrixCredential("test-matrix-platform-secret");
    await until(
      () => app.service.accountStates.get("matrix-main")?.state === "connected",
      6000,
    );
  } finally {
    await app.stop();
    await p.close();
    await receiver.close();
    await s.close();
  }
}, 15000);

test("removing an account from a binding cancels its pending delivery on restart", async () => {
  const receiver = await consumerFixture(),
    s = await stateFixture("http://127.0.0.1:1", receiver.url);
  const store = await Store.open(s.config);
  let service = new Service(store);
  try {
    await service.observe("qq-main", event("removed"));
    await service.stop();
    s.config.bindings[0]!.account_ids = ["matrix-main"];
    s.config.bindings[0]!.scopes = s.config.bindings[0]!.scopes.filter(
      (scope) => scope.account_id !== "qq-main",
    );
    service = new Service(store);
    await service.startDispatch();
    expect(
      store.db.prepare("SELECT state,category FROM deliveries").get(),
    ).toEqual({ state: "cancelled", category: "scope_revoked" });
  } finally {
    await service.stop();
    await store.close();
    await receiver.close();
    await s.close();
  }
});

test("QQ runtime outage leaves Matrix send and delivery available and reconnects without overlap", async () => {
  const p = await platformsFixture(),
    receiver = await consumerFixture(),
    s = await stateFixture(p.url, receiver.url, 1000);
  const app = await start(s.config, {
    qqOrigin: p.url,
    qqGateway: p.gateway,
    recoveryDelayMs: 250,
  });
  try {
    await until(
      () =>
        s.config.accounts.every((a) => app.service.platforms.get(a.id)?.ready),
      5000,
    );
    await p.rejectQQConnections();
    p.disconnectQQ();
    await until(() => !app.service.platforms.get("qq-main")?.ready, 5000);
    p.sendMatrix({
      body: "Post, other account still available",
      msgtype: "m.text",
    });
    await until(
      () =>
        receiver.attempts.some((x) =>
          x.includes("other account still available"),
        ),
      5000,
    );
    expect(
      (
        await app.service.call("cfl", "send_message", {
          account_id: "matrix-main",
          conversation_name: "Matrix 群聊 3",
          request_id: "runtime-outage",
          content: [{ type: "text", text: "owned reply" }],
        })
      ).status,
    ).toBe("sent");
    await p.rejectQQConnections(false);
    await until(() => app.service.platforms.get("qq-main")?.ready, 10000);
    expect(p.qqCloses.length).toBeGreaterThanOrEqual(p.qqConnections - 1);
    expect((await fetch(app.http.url + "/healthz")).status).toBe(200);
  } finally {
    await app.stop();
    await p.close();
    await receiver.close();
    await s.close();
  }
}, 25000);

test("QQ reconnect waits for the actual cancelled native send to retire", async () => {
  const p = await platformsFixture(),
    receiver = await consumerFixture(),
    s = await stateFixture(p.url, receiver.url, 8000);
  const app = await start(s.config, {
    qqOrigin: p.url,
    qqGateway: p.gateway,
    recoveryDelayMs: 100,
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const nativeFetch = globalThis.fetch;
  let cancelled = false;
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      try {
        return await nativeFetch(input, init);
      } catch (error) {
        if (String(input).includes("/messages")) {
          cancelled = true;
          await gate;
        }
        throw error;
      }
    });
  try {
    await until(
      () =>
        s.config.accounts.every((a) => app.service.platforms.get(a.id)?.ready),
      5000,
    );
    p.stall();
    const send = app.service.call("cfl", "send_message", {
      account_id: "qq-main",
      conversation_name: "QQ 群聊 1",
      request_id: "retire-before-reconnect",
      content: [{ type: "text", text: "owned pending" }],
    });
    await until(() => p.sendCount === 1, 5000);
    await p.rejectQQConnections();
    p.disconnectQQ();
    await until(() => cancelled, 8000);
    await p.rejectQQConnections(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(p.qqConnections).toBe(1);
    expect(app.service.platforms.get("matrix-main")?.ready).toBe(true);
    release();
    expect((await send).status).toBe("unknown");
    p.stall(false);
    await until(() => app.service.platforms.get("qq-main")?.ready, 10000);
    expect(p.sendCount).toBe(1);
  } finally {
    release();
    spy.mockRestore();
    await app.stop();
    await p.close();
    await receiver.close();
    await s.close();
  }
}, 25000);

test("a SQLite pin write failure is global rather than a credential diagnosis", async () => {
  const { Application } = await import("../src/runtime");
  const p = await platformsFixture(),
    s = await stateFixture(p.url, "http://127.0.0.1:2", 1500);
  p.delayWhoami(500);
  const store = await Store.open(s.config);
  const app = new Application(
    s.config,
    { qqOrigin: p.url, qqGateway: p.gateway },
    store,
  );
  try {
    await app.start();
    store.db.exec("PRAGMA query_only=ON");
    await until(() => app.service?.storageFailed, 5000);
    expect((await fetch(app.http!.url + "/healthz")).status).toBe(503);
    expect(app.service?.accountStates.get("matrix-main")?.reason).not.toBe(
      "credential_unavailable",
    );
  } finally {
    store.db.exec("PRAGMA query_only=OFF");
    await app.stop();
    await p.close();
    await s.close();
  }
});

test("real SDK rebuilds a disconnected full QQ account while Matrix delivers, then drains", async () => {
  const { httpFixture } = await import("./fixtures/http");
  let rejectQQ = true;
  const attempts: { body: string; account: string; status: number }[] = [];
  const receiver = await httpFixture(async (request) => {
    const body = await request.text();
    const account = JSON.parse(body).message.account_id as string;
    const status = account === "qq-main" && rejectQQ ? 503 : 204;
    attempts.push({ body, account, status });
    return new Response(null, { status });
  });
  const p = await platformsFixture(),
    s = await stateFixture(p.url, `http://127.0.0.1:${receiver.port}`, 1500);
  s.config.backlog_limit = 1;
  const app = await start(s.config, {
    qqOrigin: p.url,
    qqGateway: p.gateway,
    recoveryDelayMs: 250,
  });
  const captures = vi.spyOn(app.service, "observe");
  try {
    await until(
      () =>
        s.config.accounts.every((a) => app.service.platforms.get(a.id)?.ready),
      5000,
    );
    p.sendQQ("GROUP_AT_MESSAGE_CREATE", "first full queue", {
      id: "quota-first",
    });
    await until(
      () => attempts.some((a) => a.account === "qq-main" && a.status === 503),
      5000,
    );
    p.sendQQ("GROUP_AT_MESSAGE_CREATE", "over capacity", {
      id: "quota-overflow",
    });
    await until(() => app.service.errors.get("qq-main") === "capacity", 5000);
    const firstPlatform = app.service.platforms.get("qq-main");
    expect(
      app.store.db
        .prepare("SELECT id FROM messages WHERE native=?")
        .get("quota-overflow"),
    ).toBeUndefined();
    await p.rejectQQConnections();
    p.disconnectQQ();
    await until(() => !firstPlatform?.ready, 5000);
    p.sendMatrix({ body: "Post, independent account", msgtype: "m.text" });
    await until(
      () =>
        attempts.some((a) => a.account === "matrix-main" && a.status === 204),
      5000,
    );
    await until(() => {
      const current = app.service.platforms.get("qq-main");
      return !!current && current !== firstPlatform;
    }, 10000);
    expect(app.service.errors.get("qq-main")).toBe("capacity");
    expect(app.service.accountBacklog("qq-main")[0].pending).toBe(1);
    const firstReplacement = app.service.platforms.get("qq-main");
    await until(() => {
      const current = app.service.platforms.get("qq-main");
      return !!current && current !== firstReplacement;
    }, 10000);
    expect(app.service.errors.get("qq-main")).toBe("capacity");
    await p.rejectQQConnections(false);
    await until(() => app.service.platforms.get("qq-main")?.ready, 10000);
    expect(p.qqCloses.length).toBeGreaterThanOrEqual(p.qqConnections - 1);
    expect(app.service.errors.get("qq-main")).toBe("capacity");
    p.sendQQ("GROUP_AT_MESSAGE_CREATE", "still full after reconnect", {
      id: "quota-still-full",
    });
    await until(
      () =>
        captures.mock.calls.some(([, o]) => o.native_id === "quota-still-full"),
      5000,
    );
    const rejectedCapture =
      captures.mock.results[
        captures.mock.calls.findIndex(
          ([, o]) => o.native_id === "quota-still-full",
        )
      ].value;
    await expect(rejectedCapture).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(
      app.store.db
        .prepare("SELECT id FROM messages WHERE native=?")
        .get("quota-still-full"),
    ).toBeUndefined();
    expect(app.service.accountBacklog("qq-main")[0].pending).toBe(1);
    expect((await fetch(app.http.url + "/healthz")).status).toBe(200);
    const first = attempts.find((a) => a.account === "qq-main")!.body;
    rejectQQ = false;
    await until(
      () => attempts.some((a) => a.account === "qq-main" && a.status === 204),
      5000,
    );
    expect(
      attempts
        .filter((a) => a.account === "qq-main")
        .every((a) => a.body === first),
    ).toBe(true);
    await until(() => !app.service.errors.has("qq-main"), 5000);
    p.sendQQ("GROUP_AT_MESSAGE_CREATE", "after capacity drains", {
      id: "quota-resumed",
    });
    await until(
      () =>
        !!app.store.db
          .prepare("SELECT id FROM messages WHERE native=?")
          .get("quota-resumed"),
      5000,
    );
    await until(
      () =>
        attempts.some(
          (a) =>
            a.account === "qq-main" &&
            a.status === 204 &&
            a.body.includes("after capacity drains"),
        ),
      5000,
    );
  } finally {
    await app.stop();
    await p.close();
    await receiver.stop();
    await s.close();
  }
}, 30000);

// Observe the real first account Cordis start promise, without changing its outcome.
async function startObserved(
  ...args: ConstructorParameters<typeof Application>
) {
  const app = new Application(...args);
  const actualStart = app.context.start.bind(app.context);
  let settled = false;
  vi.spyOn(app.context, "start").mockImplementation(() => {
    const promise = actualStart();
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    return promise;
  });
  await app.start();
  return {
    service: app.service!,
    http: app.http!,
    sdkStartSettled: () => settled,
    stop: () => app.stop(),
  };
}

test("QQ initial SDK rejection returns without readiness, retires and rebuilds while Matrix works", async () => {
  const p = await platformsFixture(),
    receiver = await consumerFixture(),
    s = await stateFixture(p.url, receiver.url, 600);
  await p.rejectQQConnections();
  const app = await startObserved(s.config, {
    qqOrigin: p.url,
    qqGateway: p.gateway,
    recoveryDelayMs: 500,
  });
  try {
    await until(() => !!app.service.platforms.get("qq-main"), 5000);
    const first = app.service.platforms.get("qq-main");
    await until(() => p.qqAttempts > 0, 5000);
    expect(first?.ready).toBe(false);
    await until(() => app.sdkStartSettled(), 5000);
    expect(first?.ready).toBe(false);
    await until(
      () => app.service.accountStates.get("qq-main")?.next_retry_at != null,
      5000,
    );
    expect((await fetch(app.http.url + "/healthz")).status).toBe(200);
    await until(() => app.service.platforms.get("matrix-main")?.ready, 5000);
    p.sendMatrix({
      body: "Post, matrix during qq startup failure",
      msgtype: "m.text",
    });
    await until(
      () =>
        receiver.attempts.some((body) =>
          body.includes("matrix during qq startup failure"),
        ),
      5000,
    );
    await p.rejectQQConnections(false);
    await until(() => !!app.service.platforms.get("qq-main")?.ready, 5000);
    expect(app.service.platforms.get("qq-main")).not.toBe(first);
    expect((first as import("../src/host").QQPlatform).stopped).toBe(true);
    expect(p.qqConnections).toBe(1);
    expect(p.qqCloses.length).toBeGreaterThanOrEqual(p.qqConnections - 1);
  } finally {
    await app.stop();
    await p.close();
    await receiver.close();
    await s.close();
  }
}, 15000);

test("Matrix SDK initial sync errors retire and rebuild the account while QQ delivers", async () => {
  const p = await platformsFixture(),
    receiver = await consumerFixture(),
    s = await stateFixture(p.url, receiver.url, 700);
  p.rejectMatrixSync(true);
  s.config.accounts.reverse();
  const app = await startObserved(s.config, {
    qqOrigin: p.url,
    qqGateway: p.gateway,
    recoveryDelayMs: 500,
  });
  try {
    await until(() => !!app.service.platforms.get("matrix-main"), 5000);
    const first = app.service.platforms.get("matrix-main");
    await until(() => p.calls.some((c) => c.path.endsWith("/sync")), 5000);
    expect(first?.ready).toBe(false);
    await until(() => app.sdkStartSettled(), 5000);
    expect(first?.ready).toBe(false);
    await until(
      () => app.service.accountStates.get("matrix-main")?.next_retry_at != null,
      5000,
    );
    expect((await fetch(app.http.url + "/healthz")).status).toBe(200);
    await until(() => app.service.platforms.get("qq-main")?.ready, 5000);
    p.sendQQ("GROUP_AT_MESSAGE_CREATE", "qq while matrix starts");
    await until(
      () =>
        receiver.attempts.some((body) =>
          body.includes("qq while matrix starts"),
        ),
      5000,
    );
    p.rejectMatrixSync(false);
    await until(() => !!app.service.platforms.get("matrix-main")?.ready, 5000);
    expect(app.service.platforms.get("matrix-main")).not.toBe(first);
    expect((first as import("../src/matrix").MatrixUserBot).stopped).toBe(true);
  } finally {
    await app.stop();
    await p.close();
    await receiver.close();
    await s.close();
  }
}, 15000);

test("an uncertain account scope retirement is isolated and retains ownership on shutdown", async () => {
  const { Application } = await import("../src/runtime");
  const p = await platformsFixture(),
    receiver = await consumerFixture(),
    s = await stateFixture(p.url, receiver.url, 500);
  await p.rejectQQConnections();
  const app = new Application(s.config, {
    qqOrigin: p.url,
    qqGateway: p.gateway,
    recoveryDelayMs: 200,
  });
  const stop = app.context.stop.bind(app.context);
  let retirementFailed = false;
  const stopSpy = vi.spyOn(app.context, "stop").mockImplementation(async () => {
    await stop();
    retirementFailed = true;
    throw new Error("owned scope disposal failed");
  });
  try {
    await app.start();
    await until(() => retirementFailed, 5000);
    await until(
      () =>
        app.service!.accountStates.get("qq-main")?.state === "needs_attention",
      5000,
    );
    expect((await fetch(app.http!.url + "/healthz")).status).toBe(200);
    expect(app.service!.storageFailed).toBe(false);
    expect(app.service!.accountStates.get("qq-main")).toEqual({
      state: "needs_attention",
      reason: null,
      next_retry_at: null,
    });
    await until(() => app.service!.platforms.get("matrix-main")?.ready, 5000);
    p.sendMatrix({
      body: "Post, other account after retirement failure",
      msgtype: "m.text",
    });
    await until(
      () =>
        receiver.attempts.some((body) =>
          body.includes("other account after retirement failure"),
        ),
      5000,
    );
    const attempts = p.qqAttempts;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(p.qqAttempts).toBe(attempts);
    await expect(app.stop()).rejects.toThrow();
    expect(app.store!.owner.closed).toBe(false);
  } finally {
    stopSpy.mockRestore();
    await app.stop().catch(() => {});
    await app.store?.close();
    await p.close();
    await receiver.close();
    await s.close();
  }
}, 15000);

test("adapter retirement rejection is not swallowed, and does not degrade another account", async () => {
  const p = await platformsFixture(),
    receiver = await consumerFixture(),
    s = await stateFixture(p.url, receiver.url, 900);
  await p.rejectQQConnections();
  const app = new Application(s.config, {
    qqOrigin: p.url,
    qqGateway: p.gateway,
    recoveryDelayMs: 200,
  });
  let stopSpy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await app.start();
    await until(() => !!app.service!.platforms.get("qq-main"), 5000);
    const platform = app.service!.platforms.get("qq-main")!;
    const stop = platform.stop.bind(platform);
    let rejected = false;
    stopSpy = vi.spyOn(platform, "stop").mockImplementation(async () => {
      await stop();
      rejected = true;
      throw new Error("owned adapter retirement error");
    });
    await until(() => rejected, 5000);
    await until(
      () =>
        app.service!.accountStates.get("qq-main")?.state === "needs_attention",
      5000,
    );
    expect((await fetch(app.http!.url + "/healthz")).status).toBe(200);
    expect(app.service!.storageFailed).toBe(false);
    await until(() => app.service!.platforms.get("matrix-main")?.ready, 5000);
    p.sendMatrix({
      body: "Post, other account after adapter retirement",
      msgtype: "m.text",
    });
    await until(
      () =>
        receiver.attempts.some((body) =>
          body.includes("other account after adapter retirement"),
        ),
      5000,
    );
    await expect(app.stop()).rejects.toThrow();
    expect(app.store!.owner.closed).toBe(false);
  } finally {
    stopSpy?.mockRestore();
    await app.stop().catch(() => {});
    await app.store?.close();
    await p.close();
    await receiver.close();
    await s.close();
  }
}, 15000);

test("SQLite failure reported by adapter retirement degrades global health", async () => {
  const p = await platformsFixture(),
    s = await stateFixture(p.url, "http://127.0.0.1:1", 900);
  await p.rejectQQConnections();
  const app = new Application(s.config, {
    qqOrigin: p.url,
    qqGateway: p.gateway,
  });
  let stopSpy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await app.start();
    await until(() => !!app.service!.platforms.get("qq-main"), 5000);
    const platform = app.service!.platforms.get("qq-main")!;
    const stop = platform.stop.bind(platform);
    stopSpy = vi.spyOn(platform, "stop").mockImplementation(async () => {
      await stop();
      throw Object.assign(new Error("owned SQLite failure"), {
        code: "ERR_SQLITE_ERROR",
      });
    });
    await until(() => app.service!.storageFailed, 5000);
    expect((await fetch(app.http!.url + "/healthz")).status).toBe(503);
    expect(app.service!.accountStates.get("qq-main")?.state).toBe(
      "needs_attention",
    );
    await expect(app.stop()).rejects.toThrow();
    expect(app.store!.owner.closed).toBe(false);
  } finally {
    stopSpy?.mockRestore();
    await app.stop().catch(() => {});
    await app.store?.close();
    await p.close();
    await s.close();
  }
}, 15000);

test("shutdown cancels initial-account backoff and starts no late SDK requests", async () => {
  const p = await platformsFixture(),
    s = await stateFixture(p.url, "http://127.0.0.1:1", 500);
  await p.rejectQQConnections();
  const app = new Application(s.config, {
    qqOrigin: p.url,
    qqGateway: p.gateway,
    recoveryDelayMs: 1200,
  });
  try {
    await app.start();
    await until(
      () => app.service!.accountStates.get("qq-main")?.next_retry_at != null,
      5000,
    );
    await app.stop();
    const attempts = p.qqAttempts;
    const tokens = p.calls.filter(
      (c) => c.path === "/app/getAppAccessToken",
    ).length;
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(p.qqAttempts).toBe(attempts);
    expect(
      p.calls.filter((c) => c.path === "/app/getAppAccessToken"),
    ).toHaveLength(tokens);
    expect(app.store!.owner.closed).toBe(true);
  } finally {
    await app.stop();
    await p.close();
    await s.close();
  }
}, 10000);
