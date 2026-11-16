import { test, expect } from "vitest";
import { settingsFixture } from "./fixtures/settings";
import { until } from "./fixtures/state";
import { readFile } from "node:fs/promises";
import type { startQrConnect } from "@tencent-connect/qqbot-connector";

const editable = (v: any) => ({
  version: v.version,
  agents: v.agents.map(({ hasCredential, hasToken, ...a }: any) => a),
  accounts: v.accounts.map(({ hasCredential, ready, ...a }: any) => a),
  bindings: v.bindings.map(({ hasCredential, hasToken, ...b }: any) => ({
    ...b,
    scopes: b.scopes.map(({ name, ...s }: any) => s),
  })),
});
// Explicit fixture owner; verification itself never creates this association.
function ownDraft(v: any, f: Awaited<ReturnType<typeof settingsFixture>>) {
  v.agents = [
    {
      id: "cfl",
      receiver_url: f.receiver.url,
      receiver_credential: "receiver-secret",
    },
  ];
  v.bindings = [
    {
      id: "draft-owner",
      agent_id: "cfl",
      account_ids: v.accounts.map((a: any) => a.id),
      scopes: [],
      wake: {},
    },
  ];
}

test("draft Matrix exact SDK verifies proposed identity/list before persistence, empty/denied/mismatch/CSRF distinct; pins reused", async () => {
  const f = await settingsFixture(true);
  try {
    const account = {
      id: "draft",
      platform: "matrix",
      native_id: "@post:fixture",
      homeserver: f.platform.url,
      credential: "draft-secret",
    };
    expect(
      (await f.request("matrix/verify", { account, credential: "owned-draft" }))
        .status,
    ).toBe(401);
    await f.login();
    const before = await readFile(f.path, "utf8");
    const response = await f.request("matrix/verify", {
      account,
      credential: "owned-draft",
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.verified).toBe(true);
    expect(result.items.length).toBe(2);
    expect(result.items[0].name).toBe("Owned fixture room");
    expect(await readFile(f.path, "utf8")).toBe(before);
    expect(
      f.app.store.db
        .prepare("SELECT ref FROM vault WHERE ref=?")
        .get("draft-secret"),
    ).toBeUndefined();
    expect(
      f.app.store.db
        .prepare("SELECT account FROM identities WHERE account=?")
        .get("draft"),
    ).toBeUndefined();
    expect(f.platform.calls.some((c) => c.path.endsWith("/sync"))).toBe(false);
    expect(f.platform.sendCount).toBe(0);
    f.platform.encrypted(true);
    expect(
      (
        await (
          await f.request("matrix/verify", {
            account,
            credential: "owned-draft",
          })
        ).json()
      ).items.every((r: any) => r.encrypted),
    ).toBe(true);
    f.platform.joined(false);
    expect(
      (
        await (
          await f.request("matrix/verify", {
            account,
            credential: "owned-draft",
          })
        ).json()
      ).items,
    ).toEqual([]);
    expect(
      (
        await f.request("matrix/verify", {
          account: { ...account, native_id: "@wrong:fixture" },
          credential: "owned-draft",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await f.request(
          "matrix/verify",
          { account, credential: "owned-draft" },
          { "X-Post-CSRF": "wrong" },
        )
      ).status,
    ).toBe(401);
    f.platform.matrixCredential("required-owned-token");
    expect(
      (
        await f.request("matrix/verify", {
          account,
          credential: "wrong-owned-token",
        })
      ).ok,
    ).toBe(false);
  } finally {
    await f.close();
  }
  const existing = await settingsFixture();
  try {
    await existing.login();
    const account = existing.app.config.accounts.find(
      (a) => a.platform === "matrix",
    )!;
    const pin = existing.app.store.db
      .prepare("SELECT id FROM conversations WHERE account=? AND native=?")
      .get(account.id, "!room:fixture")!.id;
    const result = await (
      await existing.request("matrix/verify", { account })
    ).json();
    expect(
      result.items.find((r: any) => r.native_id === "!room:fixture")
        .conversation_id,
    ).toBe(pin);
    existing.platform.matrixCredential("owned-replacement");
    expect((await existing.request("matrix/verify", { account })).ok).toBe(
      false,
    );
    expect(
      (
        await existing.request("matrix/verify", {
          account,
          credential: "owned-replacement",
        })
      ).status,
    ).toBe(200);
  } finally {
    await existing.close();
  }
});

test("QQ QR callback stays server-held, owner/CSRF bounded; explicit save seals credential, late callback cannot alter it", async () => {
  let cb!: Parameters<typeof startQrConnect>[0];
  const connector: typeof startQrConnect = (callbacks, options) => {
    cb = callbacks;
    callbacks.onQrDisplayed?.(
      "https://q.qq.com/qqbot/openclaw/connect.html?task_id=owned",
    );
    return () => callbacks.onFailure(Error("cancelled fixture"));
  };
  const f = await settingsFixture(true, 1500, connector);
  try {
    expect(
      (
        await f.request("connect/qq", {
          action: "start",
          account_id: "new-scan",
        })
      ).status,
    ).toBe(401);
    await f.login();
    await f.app.store.pin("scan-qq", "qq", "qq-app");
    const pins = f.app.store.db.prepare("SELECT * FROM identities").all();
    expect(
      (
        await f.request(
          "connect/qq",
          { action: "start", account_id: "new-scan" },
          { "X-Post-CSRF": "wrong" },
        )
      ).status,
    ).toBe(401);
    const qr = await (
      await f.request("connect/qq", { action: "start", account_id: "new-scan" })
    ).json();
    expect(["starting", "waiting"]).toContain(qr.state);
    await until(() => !!cb);
    expect(qr.expires - Date.now()).toBeGreaterThan(119000);
    expect(
      (
        await f.request("connect/qq", {
          action: "start",
          account_id: "new-scan",
        })
      ).status,
    ).toBe(409);
    expect((await f.request("connect/qq?id=wrong")).status).toBe(401);
    cb.onQrExpired?.();
    expect(
      (await (await f.request("connect/qq?id=" + qr.id)).json()).state,
    ).toBe("refreshing");
    cb.onQrDisplayed?.(
      "https://q.qq.com/qqbot/openclaw/connect.html?task_id=refreshed",
    );
    cb.onSuccess([
      {
        appId: "qq-app",
        appSecret: "owned-scan-secret",
        userOpenid: "not-an-admission-grant",
      },
    ]);
    await until(
      async () =>
        (await (await f.request("connect/qq?id=" + qr.id)).json()).state ===
        "authorized",
    );
    const publicResult = await (
      await f.request("connect/qq?id=" + qr.id)
    ).json();
    expect(publicResult.account_id).toBe("scan-qq");
    expect(f.app.store.db.prepare("SELECT * FROM identities").all()).toEqual(
      pins,
    );
    expect(f.app.config.accounts).toEqual([]);
    expect(JSON.stringify(publicResult)).not.toContain("owned-scan-secret");
    expect(JSON.stringify(publicResult)).not.toContain(
      "not-an-admission-grant",
    );
    expect(
      f.app.store.db
        .prepare("SELECT ref FROM vault WHERE ref=?")
        .get("scan-secret"),
    ).toBeUndefined();
    const v = editable(await (await f.request("settings")).json());
    v.accounts = [
      {
        id: "scan-qq",
        platform: "qq",
        native_id: "qq-app",
        credential: "scan-secret",
      },
    ];
    ownDraft(v, f);
    const ack = await (
      await f.request("settings", {
        ...v,
        qq_authorization: { id: qr.id, account_id: "scan-qq" },
      })
    ).json();
    expect(ack.saved).toBe(true);
    await f.app.pending;
    expect(f.app.status().applied).toBe(true);
    expect(await f.app.store.secret("scan-secret", "scan-qq", "platform")).toBe(
      "owned-scan-secret",
    );
    expect(await readFile(f.path, "utf8")).not.toContain("owned-scan-secret");
    cb.onSuccess([{ appId: "late", appSecret: "late-secret" }]);
    expect(await f.app.store.secret("scan-secret", "scan-qq", "platform")).toBe(
      "owned-scan-secret",
    );
    expect(
      (await (await f.request("connect/qq?id=" + qr.id)).json()).state,
    ).toBe("committed");
    const committed = await readFile(f.path, "utf8");
    const previousCallback = cb;
    const duplicate = await (
      await f.request("connect/qq", {
        action: "start",
        account_id: "different-wizard",
      })
    ).json();
    await until(() => cb !== previousCallback);
    cb.onSuccess([{ appId: "qq-app", appSecret: "not-adopted" }]);
    await until(
      async () =>
        (await (await f.request("connect/qq?id=" + duplicate.id)).json())
          .state === "conflict",
    );
    expect(await readFile(f.path, "utf8")).toBe(committed);
    expect(f.app.store.db.prepare("SELECT * FROM identities").all()).toEqual(
      pins,
    );
    expect(await f.app.store.secret("scan-secret", "scan-qq", "platform")).toBe(
      "owned-scan-secret",
    );
  } finally {
    await f.close();
  }
});

test("QQ cancel and absolute expiry retire operation and ignore credentials without persistence", async () => {
  let cb!: Parameters<typeof startQrConnect>[0],
    stops = 0;
  const f = await settingsFixture(
    true,
    1500,
    (callbacks) => {
      cb = callbacks;
      return () => {
        stops++;
        callbacks.onFailure(Error("fixture"));
      };
    },
    150,
  );
  try {
    await f.login();
    const before = await readFile(f.path, "utf8");
    const first = await (
      await f.request("connect/qq", { action: "start", account_id: "scan-qq" })
    ).json();
    await until(() => !!cb);
    await f.request("connect/qq", { action: "cancel", id: first.id });
    cb.onSuccess([{ appId: "late", appSecret: "not-saved" }]);
    expect(
      (await (await f.request("connect/qq?id=" + first.id)).json()).state,
    ).toBe("cancelled");
    const next = await (
      await f.request("connect/qq", { action: "start", account_id: "scan-qq" })
    ).json();
    await until(
      async () =>
        (await (await f.request("connect/qq?id=" + next.id)).json()).state ===
        "expired",
    );
    cb.onSuccess([{ appId: "later", appSecret: "not-saved" }]);
    expect(stops).toBeGreaterThan(0);
    expect(await readFile(f.path, "utf8")).toBe(before);
  } finally {
    await f.close();
  }
});

test("saved Matrix onboarding survives connection failure and preserves pins and grants on repair", async () => {
  const f = await settingsFixture(true, 300);
  try {
    await f.login();
    f.platform.matrixCredential("corrected-token");
    const account = {
      id: "retained",
      platform: "matrix",
      native_id: "@post:fixture",
      homeserver: f.platform.url,
      credential: "initial-secret",
    };
    const binding = {
      id: "retry-binding",
      agent_id: "retry-agent",
      account_ids: [account.id],
      enabled: true,
      scopes: [
        {
          account_id: account.id,
          conversation_id: "retained-room",
          native_id: "!room:fixture",
          type: "group",
          senders: [],
        },
      ],
      wake: {},
    };
    const initial = editable(await f.app.view());
    const ack = await (
      await f.request("settings", {
        ...initial,
        accounts: [account],
        bindings: [binding],
        agents: [
          {
            id: "retry-agent",
            receiver_url: f.receiver.url,
            receiver_credential: "retry-receiver",
          },
        ],
        secrets: [
          {
            ref: account.credential,
            account: account.id,
            kind: "platform",
            value: "rejected-token",
          },
          {
            ref: "retry-receiver",
            account: "retry-agent",
            kind: "receiver",
            value: "owned-receiver",
          },
        ],
      })
    ).json();
    expect(ack.saved).toBe(true);
    await f.app.pending;
    await until(
      () =>
        f.app.app.service?.accountStates.get(account.id)?.state ===
        "needs_attention",
      5000,
    );
    expect(f.app.status().applied).toBe(true);
    const conversation = f.app.store.db
      .prepare("SELECT id,account,native,type FROM conversations WHERE id=?")
      .get("retained-room");
    expect(conversation).toMatchObject({
      account: account.id,
      native: "!room:fixture",
    });
    const saved = editable(await f.app.view());
    const repair = await f.request("settings", {
      ...saved,
      secrets: [
        {
          ref: account.credential,
          account: account.id,
          kind: "platform",
          value: "corrected-token",
        },
      ],
    });
    expect(repair.status).toBe(200);
    await f.app.pending;
    await until(
      () => f.app.app.service?.platforms.get(account.id)?.ready,
      5000,
    );
    expect(
      f.app.store.db
        .prepare("SELECT id,account,native,type FROM conversations WHERE id=?")
        .get("retained-room"),
    ).toEqual(conversation);
    expect(
      f.app.store.db
        .prepare(
          "SELECT account,platform,native FROM identities WHERE account=?",
        )
        .get(account.id),
    ).toEqual({
      account: account.id,
      platform: "matrix",
      native: "@post:fixture",
    });
    expect(f.app.config.bindings[0]?.scopes[0]?.conversation_id).toBe(
      "retained-room",
    );
  } finally {
    await f.close();
  }
});

test.each(["cancel", "logout"])(
  "QQ saved authorization is consumed once even when %s follows",
  async (action) => {
    let cb!: Parameters<typeof startQrConnect>[0];
    let scans = 0;
    const f = await settingsFixture(true, 300, (callbacks) => {
      cb = callbacks;
      scans++;
      return () => callbacks.onFailure(Error("owned cancellation"));
    });
    try {
      await f.login();
      const qr = await (
        await f.request("connect/qq", {
          action: "start",
          account_id: "saved-scan",
        })
      ).json();
      await until(() => !!cb);
      cb.onSuccess([{ appId: "qq-app", appSecret: "owned-scan-secret" }]);
      await until(
        async () =>
          (await (await f.request("connect/qq?id=" + qr.id)).json()).state ===
          "authorized",
      );
      const v = editable(await f.app.view());
      v.accounts = [
        {
          id: "saved-scan",
          platform: "qq",
          native_id: "qq-app",
          credential: "saved-secret",
        },
      ];
      ownDraft(v, f);
      f.platform.tokenStall(true);
      const ack = await (
        await f.request("settings", {
          ...v,
          qq_authorization: { id: qr.id, account_id: "saved-scan" },
        })
      ).json();
      expect(ack.saved).toBe(true);
      await f.app.pending;
      await until(
        async () =>
          (await (await f.request("connect/qq?id=" + qr.id)).json()).state ===
          "committed",
        5000,
      );
      expect(f.app.status().applied).toBe(true);
      expect(
        await f.app.store.secret("saved-secret", "saved-scan", "platform"),
      ).toBe("owned-scan-secret");
      expect(
        JSON.stringify(await (await f.request("status")).json()),
      ).not.toContain("owned-scan-secret");
      if (action === "logout") {
        expect((await f.request("logout", {})).status).toBe(200);
        await f.login();
      } else await f.request("connect/qq", { action: "cancel", id: qr.id });
      const replay = await f.request("settings", {
        ...editable(await f.app.view()),
        qq_authorization: { id: qr.id, account_id: "saved-scan" },
      });
      expect(replay.ok).toBe(false);
      expect(scans).toBe(1);
      expect(
        await f.app.store.secret("saved-secret", "saved-scan", "platform"),
      ).toBe("owned-scan-secret");
    } finally {
      await f.close();
    }
  },
);

test.each(["expired", "cancelled", "logout"])(
  "QQ %s during a durably accepted apply cannot replay its authorization",
  async (outcome) => {
    let cb!: Parameters<typeof startQrConnect>[0];
    const f = await settingsFixture(
      true,
      1500,
      (callbacks) => {
        cb = callbacks;
        return () => callbacks.onFailure(Error("owned cancellation"));
      },
      outcome === "expired" ? 200 : 5000,
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await f.login();
      const qr = await (
        await f.request("connect/qq", {
          action: "start",
          account_id: "held-scan",
        })
      ).json();
      await until(() => !!cb);
      cb.onSuccess([{ appId: "qq-app", appSecret: "owned-held-secret" }]);
      await until(
        async () =>
          (await (await f.request("connect/qq?id=" + qr.id)).json()).state ===
          "authorized",
      );
      const connect = (f.app as any).connect.bind(f.app);
      (f.app as any).connect = async (app: unknown) => {
        await held;
        return connect(app);
      };
      const v = editable(await f.app.view());
      v.accounts = [
        {
          id: "held-scan",
          platform: "qq",
          native_id: "qq-app",
          credential: "held-secret",
        },
      ];
      ownDraft(v, f);
      const ack = await (
        await f.request("settings", {
          ...v,
          qq_authorization: { id: qr.id, account_id: "held-scan" },
        })
      ).json();
      expect(ack).toMatchObject({ saved: true, applied: false });
      expect(f.app.status().busy).toBe(true);
      if (outcome === "expired")
        await until(
          async () =>
            (await (await f.request("connect/qq?id=" + qr.id)).json()).state ===
            "expired",
          3000,
        );
      else if (outcome === "cancelled")
        expect(
          (await f.request("connect/qq", { action: "cancel", id: qr.id }))
            .status,
        ).toBe(200);
      else expect((await f.request("logout", {})).status).toBe(200);
      release();
      await f.app.pending;
      expect(f.app.status().applied).toBe(true);
      expect(
        await f.app.store.secret("held-secret", "held-scan", "platform"),
      ).toBe("owned-held-secret");
      if (outcome === "logout") await f.login();
      const view = await f.app.view();
      const replay = await f.request("settings", {
        ...editable(view),
        qq_authorization: { id: qr.id, account_id: "held-scan" },
      });
      expect(replay.ok).toBe(false);
      expect(JSON.stringify(view)).not.toContain("owned-held-secret");
    } finally {
      release();
      await f.close();
    }
  },
);
