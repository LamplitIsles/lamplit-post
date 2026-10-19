import { test, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { until } from "./fixtures/state";
import { settingsFixture } from "./fixtures/settings";

const editable = (v: any) => ({
  version: v.version,
  accounts: v.accounts.map(({ hasCredential, ready, ...a }: any) => a),
  bindings: v.bindings.map(({ hasCredential, hasToken, ...b }: any) => b),
});

test("20 declared serial valid local durable acknowledgements meet p95 without waiting for apply", async () => {
  const f = await settingsFixture(true);
  const samples: number[] = [];
  try {
    await f.login();
    // Fixed sample count, no warm-up removal or retry. Owned local storage, one zero-grant consumer.
    for (let i = 0; i < 20; i++) {
      const v = editable(await (await f.request("settings")).json());
      v.bindings = [
        {
          id: "sample",
          agent_id: "sample",
          name: `Sample ${i}`,
          receiver_url: f.receiver.url,
          receiver_credential: "sample-secret",
          enabled: true,
          scopes: [],
          wake: {},
        },
      ];
      const start = performance.now();
      const response = await f.request("settings", {
        ...v,
        secrets:
          i === 0
            ? [
                {
                  ref: "sample-secret",
                  account: "sample",
                  kind: "receiver",
                  value: "owned-sample-secret",
                },
              ]
            : [],
      });
      const ack = await response.json();
      samples.push(performance.now() - start);
      expect(response.status).toBe(200);
      expect(ack.saved).toBe(true);
      expect(ack.applied).toBe(false);
      expect(await readFile(f.path, "utf8")).toContain(`Sample ${i}`);
      await f.app.pending;
      expect(f.app.status().applied).toBe(true);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    console.info(
      JSON.stringify({
        metric: "durable_save_ack",
        count: 20,
        samples_ms: samples.map((n) => +n.toFixed(2)),
        median_ms: +((sorted[9] + sorted[10]) / 2).toFixed(2),
        p95_ms: +sorted[18].toFixed(2),
        max_ms: +sorted[19].toFixed(2),
      }),
    );
    expect(sorted[18]).toBeLessThanOrEqual(500);
  } finally {
    await f.close();
  }
});

test("11500ms real SDK reply has fast durable ack, nonblocking status, fail-fast busy and actual later readiness", async () => {
  const f = await settingsFixture(true, 30000);
  try {
    await f.login();
    const v = editable(await (await f.request("settings")).json());
    v.accounts = [
      {
        id: "slow",
        platform: "matrix",
        native_id: "@post:fixture",
        homeserver: f.platform.url,
        credential: "slow-secret",
      },
    ];
    f.platform.delayWhoami(11500);
    const start = performance.now();
    const response = await f.request("settings", {
      ...v,
      secrets: [
        {
          ref: "slow-secret",
          account: "slow",
          kind: "platform",
          value: "owned-slow-secret",
        },
      ],
    });
    const ack = await response.json(),
      ackMs = performance.now() - start;
    expect(ack.saved).toBe(true);
    expect(ack.applied).toBe(false);
    expect(ackMs).toBeLessThanOrEqual(500);
    const readStart = performance.now(),
      status = await (await f.request("status")).json();
    const statusMs = performance.now() - readStart;
    expect(statusMs).toBeLessThanOrEqual(500);
    expect(status.state).toBe("applying");
    expect(status.active_version).toBeNull();
    const busyStart = performance.now();
    expect((await f.request("settings", v)).status).toBe(409);
    const busyMs = performance.now() - busyStart;
    expect(busyMs).toBeLessThanOrEqual(500);
    await f.app.pending;
    const ready = await (await f.request("status")).json();
    expect(ready.applied).toBe(true);
    expect(ready.active_version).toBe(ack.accepted_version);
    expect(f.app.store.owner.closed).toBe(false);
    expect(f.platform.sendCount).toBe(0);
    console.info(
      JSON.stringify({
        metric: "slow_native_save",
        ack_ms: Math.round(ackMs),
        ready_ms: Math.round(performance.now() - start),
        applied: ready.applied,
      }),
    );
    const staleStart = performance.now();
    expect((await f.request("settings", v)).status).toBe(409);
    const staleMs = performance.now() - staleStart;
    expect(staleMs).toBeLessThanOrEqual(500);
    const invalidStart = performance.now();
    expect(
      (
        await f.request("settings", {
          ...editable(await f.app.view()),
          unexpected: true,
        })
      ).status,
    ).toBe(400);
    const invalidMs = performance.now() - invalidStart;
    expect(invalidMs).toBeLessThanOrEqual(500);
    console.info(
      JSON.stringify({
        metric: "management_read_rejections",
        status_ms: statusMs,
        busy_ms: busyMs,
        stale_ms: staleMs,
        invalid_ms: invalidMs,
      }),
    );
  } finally {
    await f.close();
  }
});

test("slow old retirement returns unsaved, overruns report draining while lease retained, never mutates later", async () => {
  const f = await settingsFixture(true);
  let release!: () => void;
  try {
    await f.login();
    const before = await readFile(f.path, "utf8"),
      v = editable(await f.app.view());
    f.app.app.service!.track(new Promise<void>((r) => (release = r)));
    const start = performance.now();
    const ack = await (await f.request("settings", v)).json();
    expect(ack.saved).toBe(false);
    expect(performance.now() - start).toBeLessThanOrEqual(500);
    expect(await readFile(f.path, "utf8")).toBe(before);
    await until(() => f.app.status().state === "failed_draining");
    expect(f.app.status().busy).toBe(true);
    expect(f.app.store.owner.closed).toBe(false);
    release();
    await f.app.pending;
    expect(await readFile(f.path, "utf8")).toBe(before);
    expect(f.app.status().saved).toBe(false);
    expect(f.app.status().state).toBe("failed_recovered");
  } finally {
    release?.();
    await f.close();
  }
});

test("total connect budget spans multiple individually-valid reads, restores prior version once without false applied", async () => {
  const f = await settingsFixture(true, 300);
  try {
    await f.login();
    const v = editable(await f.app.view()),
      before = await readFile(f.path, "utf8");
    f.platform.delayMatrixReads(200);
    v.accounts = [
      {
        id: "deadline",
        platform: "matrix",
        native_id: "@post:fixture",
        homeserver: f.platform.url,
        credential: "deadline-secret",
      },
    ];
    const ack = await (
      await f.request("settings", {
        ...v,
        secrets: [
          {
            ref: "deadline-secret",
            account: "deadline",
            kind: "platform",
            value: "owned-deadline",
          },
        ],
      })
    ).json();
    expect(ack.saved).toBe(true);
    await f.app.pending;
    const result = f.app.status();
    expect(result.state).toBe("failed_recovered");
    expect(result.accepted_version).toBe(ack.accepted_version);
    expect(result.current_version).toBe(v.version);
    expect(result.active_version).toBe(v.version);
    expect(result.applied).toBe(false);
    expect(await readFile(f.path, "utf8")).toBe(before);
    expect(
      f.app.store.db
        .prepare("SELECT ref FROM vault WHERE ref=?")
        .get("deadline-secret"),
    ).toBeUndefined();
    expect(f.platform.aborts).toBeGreaterThan(0);
  } finally {
    await f.close();
  }
});

test("later native loss cannot be reported as applied readiness for the accepted version", async () => {
  const f = await settingsFixture();
  try {
    expect(f.app.status().applied).toBe(true);
    f.platform.planSync(() =>
      Response.json({ errcode: "M_UNKNOWN" }, { status: 500 }),
    );
    await until(() => !f.app.app.service!.platforms.get("matrix-main")!.ready);
    expect(f.app.status().ready).toBe(false);
    expect(f.app.status().applied).toBe(false);
    expect(f.app.status().accepted_version).toBe(
      f.app.status().current_version,
    );
  } finally {
    await f.close();
  }
});

test("credential-only failed replacement cannot claim restored old readiness applied the latest save", async () => {
  const f = await settingsFixture();
  try {
    await f.login();
    const valid = "owned-valid-replacement";
    f.platform.matrixCredential(valid);
    const replace = async (value: string) => {
      const view = editable(await (await f.request("settings")).json());
      const response = await f.request("settings", {
        ...view,
        secrets: [
          {
            ref: "matrix-secret",
            account: "matrix-main",
            kind: "platform",
            value,
          },
        ],
      });
      expect(response.status).toBe(200);
      const ack = await response.json();
      await f.app.pending;
      return { ack, final: await (await f.request("status")).json() };
    };
    // Canonicalize through the real save path, also proving a valid credential-only control.
    const control = await replace(valid);
    expect(control.ack.saved).toBe(true);
    expect(control.ack.applied).toBe(false);
    expect(control.final.applied).toBe(true);
    const before = await readFile(f.path, "utf8");
    const identities = f.app.store.db
      .prepare("SELECT * FROM identities ORDER BY account")
      .all();
    const conversations = f.app.store.db
      .prepare("SELECT * FROM conversations ORDER BY id")
      .all();
    const owner = f.app.store.owner;
    const { ack, final } = await replace("owned-invalid-replacement");
    const vaultRestored =
      (await f.app.store.secret("matrix-secret", "matrix-main", "platform")) ===
      valid;
    console.info(
      JSON.stringify({
        observation: "credential_only_rollback",
        ack: { saved: ack.saved, applied: ack.applied, state: ack.state },
        final,
        tomlUnchanged: (await readFile(f.path, "utf8")) === before,
        vaultRestored,
        sameOwner: f.app.store.owner === owner && !owner.closed,
      }),
    );
    expect(ack.saved).toBe(true);
    expect(ack.applied).toBe(false);
    expect(final.state).toBe("failed_recovered");
    expect(final.ready).toBe(true);
    expect(final.accepted_version).toBe(control.final.current_version);
    expect(final.current_version).toBe(final.accepted_version);
    expect(final.active_version).toBe(final.accepted_version);
    expect(await readFile(f.path, "utf8")).toBe(before);
    expect(vaultRestored).toBe(true);
    expect(f.app.store.owner).toBe(owner);
    expect(owner.closed).toBe(false);
    expect(
      f.app.store.db.prepare("SELECT * FROM identities ORDER BY account").all(),
    ).toEqual(identities);
    expect(
      f.app.store.db.prepare("SELECT * FROM conversations ORDER BY id").all(),
    ).toEqual(conversations);
    expect(final.applied).toBe(false);
    expect(final.saved).toBe(false);
    // A subsequent valid replacement remains possible after recovery, at this same TOML version.
    expect((await replace(valid)).final.applied).toBe(true);
  } finally {
    await f.close();
  }
});

test("authenticated bodyless status GET preserves keepalive for the following actual save", async () => {
  const { Agent, request } = await import("node:http");
  const f = await settingsFixture(true);
  const agent = new Agent({ keepAlive: true });
  const sockets: import("node:net").Socket[] = [];
  try {
    const login = await f.login();
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const { csrf } = await (await f.request("session")).json();
    const input = editable(await f.app.view());
    f.web.server.on("request", (req) => sockets.push(req.socket));
    const call = (method: string, route: string, input?: unknown) =>
      new Promise<any>((resolve, reject) => {
        const body = input === undefined ? undefined : JSON.stringify(input);
        const req = request(
          f.config.settings.origin + "/api/" + route,
          {
            method,
            agent,
            headers: {
              cookie,
              origin: f.config.settings.origin,
              "X-Post-CSRF": csrf,
              ...(body === undefined
                ? {}
                : {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body),
                  }),
            },
          },
          (res) => {
            let text = "";
            res.on("data", (chunk) => (text += chunk));
            res.once("error", reject);
            res.once("end", () =>
              resolve({ status: res.statusCode, ...JSON.parse(text) }),
            );
          },
        );
        req.once("error", reject);
        req.end(body);
      });
    expect((await call("GET", "status")).ready).toBe(true);
    const prematurelyDestroyed = sockets[0].destroyed;
    // Execute the caller chain once even on red: no mutation retry on reset.
    const result = await call("POST", "settings", input).catch((error) => ({
      error: error.code,
    }));
    console.info(
      JSON.stringify({
        observation: "GET then actual save keepalive",
        prematurelyDestroyed,
        requests: sockets.length,
        sameSocket: sockets.length === 2 && sockets[0] === sockets[1],
        result: {
          status: result.status,
          saved: result.saved,
          error: result.error,
        },
      }),
    );
    expect(prematurelyDestroyed).toBe(false);
    expect(result.status).toBe(200);
    expect(result.saved).toBe(true);
    expect(result.applied).toBe(false);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]).toBe(sockets[0]);
    expect(sockets[1].destroyed).toBe(false);
    await f.app.pending;
    expect(f.app.status().applied).toBe(true);
  } finally {
    agent.destroy();
    await f.close();
  }
});

test.each(["oversize", "unread", "aborted"])(
  "management still retires %s incomplete request bodies without mutation",
  async (mode) => {
    const { createConnection } = await import("node:net");
    const f = await settingsFixture(true);
    let client: import("node:net").Socket | undefined;
    try {
      const login = await f.login();
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const { csrf } = await (await f.request("session")).json();
      const before = await readFile(f.path, "utf8");
      const received = new Promise<import("node:http").IncomingMessage>(
        (resolve) => f.web.server.once("request", resolve),
      );
      client = createConnection(f.config.settings.port, "127.0.0.1");
      client.on("error", () => {});
      const closed = new Promise<void>((resolve) =>
        client!.once("close", () => resolve()),
      );
      const method = mode === "unread" ? "GET" : "POST",
        route = mode === "unread" ? "status" : "settings";
      client.write(
        `${method} /api/${route} HTTP/1.1\r\nHost: ${new URL(f.config.settings.origin).host}\r\nOrigin: ${f.config.settings.origin}\r\nCookie: ${cookie}\r\nX-Post-CSRF: ${csrf}\r\nContent-Type: application/json\r\nContent-Length: 200000\r\n\r\n`,
      );
      client.write(mode === "oversize" ? " ".repeat(131073) : "{");
      client.resume();
      const req = await received;
      if (mode === "aborted") {
        const aborted = new Promise<void>((resolve) =>
          req.once("aborted", resolve),
        );
        client.destroy();
        await aborted;
      }
      let timer: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(Error("Owned incomplete request did not retire")),
              1500,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer!);
      }
      expect(req.complete).toBe(false);
      expect(req.destroyed).toBe(true);
      expect(await readFile(f.path, "utf8")).toBe(before);
      expect(f.app.status().busy).toBe(false);
      expect(f.app.store.owner.closed).toBe(false);
    } finally {
      client?.destroy();
      await f.close();
    }
  },
);
