import { test, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { until } from "./fixtures/state";
import { settingsFixture } from "./fixtures/settings";

const editable = (v: any) => ({
  version: v.version,
  agents: v.agents.map(({ hasCredential, hasToken, ...a }: any) => a),
  accounts: v.accounts.map(({ hasCredential, ready, ...a }: any) => a),
  bindings: v.bindings.map(({ hasCredential, hasToken, ...b }: any) => ({
    ...b,
    scopes: b.scopes.map(({ name, ...s }: any) => s),
  })),
});

test("20 declared serial valid local durable acknowledgements meet p95 without waiting for apply", async () => {
  const f = await settingsFixture(true);
  const samples: number[] = [];
  try {
    await f.login();
    // Fixed sample count, no warm-up removal or retry. Owned local storage, one zero-grant consumer.
    for (let i = 0; i < 20; i++) {
      const v = editable(await (await f.request("settings")).json());
      v.agents = [
        {
          id: "sample",
          name: `Sample ${i}`,
          receiver_url: f.receiver.url,
          receiver_credential: "sample-secret",
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
    process.stdout.write(
      JSON.stringify({
        metric: "durable_save_ack",
        count: 20,
        samples_ms: samples.map((n) => +n.toFixed(2)),
        median_ms: +((sorted[9] + sorted[10]) / 2).toFixed(2),
        p95_ms: +sorted[18].toFixed(2),
        max_ms: +sorted[19].toFixed(2),
      }) + "\n",
    );
    expect(sorted[18]).toBeLessThanOrEqual(500);
  } finally {
    await f.close();
  }
});

test("slow real SDK connection does not delay durable application and later becomes ready", async () => {
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
    v.agents = [
      {
        id: "cfl",
        receiver_url: f.receiver.url,
        receiver_credential: "receiver-secret",
      },
    ];
    v.bindings = [
      {
        id: "slow-owner",
        agent_id: "cfl",
        account_ids: ["slow"],
        scopes: [],
        wake: {},
      },
    ];
    f.platform.delayWhoami(800);
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
    await f.app.pending;
    expect(["applying", "applied"]).toContain(status.state);
    await until(() => f.app.app.service?.platforms.get("slow")?.ready, 5000);
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
    const competing = await f.request("settings", v);
    expect(competing.status).toBe(409);
    expect(await competing.json()).toMatchObject({
      error: "conflict",
      busy: true,
    });
    expect(await readFile(f.path, "utf8")).toBe(before);
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

test("slow native connection preserves accepted configuration while recovering", async () => {
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
    v.agents = [
      {
        id: "cfl",
        receiver_url: f.receiver.url,
        receiver_credential: "receiver-secret",
      },
    ];
    v.bindings = [
      {
        id: "deadline-owner",
        agent_id: "cfl",
        account_ids: ["deadline"],
        scopes: [],
        wake: {},
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
    expect(result.state).toBe("applied");
    expect(result.accepted_version).toBe(ack.accepted_version);
    expect(result.current_version).toBe(ack.accepted_version);
    expect(result.active_version).toBe(ack.accepted_version);
    expect(result.applied).toBe(true);
    expect(await readFile(f.path, "utf8")).not.toBe(before);
    expect(
      f.app.store.db
        .prepare("SELECT ref FROM vault WHERE ref=?")
        .get("deadline-secret"),
    ).toBeDefined();
  } finally {
    await f.close();
  }
});

test("later native loss preserves applied configuration while account recovers", async () => {
  const f = await settingsFixture();
  try {
    expect(f.app.status().applied).toBe(true);
    f.platform.planSync(() =>
      Response.json({ errcode: "M_UNKNOWN" }, { status: 500 }),
    );
    await until(() => !f.app.app.service!.platforms.get("matrix-main")!.ready);
    expect(f.app.status().ready).toBe(true);
    expect(f.app.status().applied).toBe(true);
    expect(f.app.status().accepted_version).toBe(
      f.app.status().current_version,
    );
  } finally {
    await f.close();
  }
});

test("credential replacement stays applied while rejected account needs attention, then correction works", async () => {
  const f = await settingsFixture();
  try {
    await f.login();
    const valid = "owned-valid-replacement";
    f.platform.matrixCredential(valid);
    const replace = async (value: string) => {
      const view = editable(await f.app.view());
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
      return ack;
    };
    const owner = f.app.store.owner;
    expect((await replace("owned-invalid-replacement")).saved).toBe(true);
    await until(
      () =>
        f.app.app.service?.accountStates.get("matrix-main")?.state ===
        "needs_attention",
      5000,
    );
    expect(f.app.app.service?.accountStates.get("matrix-main")?.reason).toBe(
      "authentication_rejected",
    );
    expect(f.app.status().applied).toBe(true);
    expect(
      await f.app.store.secret("matrix-secret", "matrix-main", "platform"),
    ).toBe("owned-invalid-replacement");
    expect(f.app.store.owner).toBe(owner);
    expect((await replace(valid)).saved).toBe(true);
    await until(
      () => f.app.app.service?.platforms.get("matrix-main")?.ready,
      5000,
    );
    expect(f.app.status().applied).toBe(true);
    expect(f.app.store.owner).toBe(owner);
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
