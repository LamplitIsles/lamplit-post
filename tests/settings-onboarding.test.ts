import { test, expect } from "vitest";
import { settingsFixture } from "./fixtures/settings";
import { until } from "./fixtures/state";
import { readFile } from "node:fs/promises";
import type { startQrConnect } from "@tencent-connect/qqbot-connector";

const editable = (v: any) => ({
  version: v.version,
  accounts: v.accounts.map(({ hasCredential, ready, ...a }: any) => a),
  bindings: v.bindings.map(({ hasCredential, hasToken, ...b }: any) => b),
});

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

test("verified failed onboarding reuses orphan account and conversation pins after discard/reload, without reattaching credentials or grants", async () => {
  const f = await settingsFixture(true, 300);
  try {
    await f.login();
    const vaultBefore = f.app.store.db
      .prepare("SELECT ref,account,kind FROM vault ORDER BY ref")
      .all();
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
      receiver_url: f.receiver.url,
      receiver_credential: "retry-receiver",
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
    f.platform.delayMatrixReads(200);
    const ack = await (
      await f.request("settings", {
        ...initial,
        accounts: [account],
        bindings: [binding],
        secrets: [
          {
            ref: account.credential,
            account: account.id,
            kind: "platform",
            value: "first-owned-token",
          },
          {
            ref: binding.receiver_credential,
            account: binding.id,
            kind: "receiver",
            value: "first-owned-receiver",
          },
        ],
      })
    ).json();
    expect(ack.saved).toBe(true);
    await f.app.pending;
    expect(f.app.status().state).toBe("failed_recovered");
    expect(f.app.config.accounts).toEqual([]);
    const pins = () => ({
      identities: f.app.store.db
        .prepare("SELECT * FROM identities ORDER BY account")
        .all(),
      conversations: f.app.store.db
        .prepare("SELECT id,account,native,type FROM conversations ORDER BY id")
        .all(),
    });
    const before = pins();
    expect(before.identities).toHaveLength(1);
    expect(before.conversations).toHaveLength(1);
    f.platform.delayMatrixReads(0);
    const fresh = {
      ...account,
      id: "fresh-wizard",
      credential: "fresh-secret",
    };
    const result = await (
      await f.request("matrix/verify", {
        account: fresh,
        credential: "new-owned-token",
      })
    ).json();
    expect(result.verified).toBe(true);
    expect(result.account.id).toBe(account.id);
    expect(result.account.credential).toBe("fresh-secret");
    expect(
      result.items.find((r: any) => r.native_id === "!room:fixture")
        .conversation_id,
    ).toBe("retained-room");
    expect(pins()).toEqual(before);
    expect(f.app.config.accounts).toEqual([]);
    expect(
      f.app.store.db
        .prepare("SELECT ref,account,kind FROM vault ORDER BY ref")
        .all(),
    ).toEqual(vaultBefore);
    expect(
      f.app.verifiedDraftId.bind(f.app, "qq", "@post:fixture", account.id),
    ).toThrow();
    expect(
      f.app.verifiedDraftId.bind(f.app, "matrix", "@wrong:fixture", account.id),
    ).toThrow();
    const reload = editable(await (await f.request("settings")).json());
    const retry = await (
      await f.request("settings", {
        ...reload,
        accounts: [result.account],
        bindings: [binding],
        secrets: [
          {
            ref: result.account.credential,
            account: account.id,
            kind: "platform",
            value: "new-owned-token",
          },
          {
            ref: binding.receiver_credential,
            account: binding.id,
            kind: "receiver",
            value: "new-owned-receiver",
          },
        ],
      })
    ).json();
    expect(retry.saved).toBe(true);
    await f.app.pending;
    expect(f.app.status().applied).toBe(true);
    expect(pins()).toEqual(before);
    const configured = await readFile(f.path, "utf8");
    expect(
      (
        await f.request("matrix/verify", {
          account: fresh,
          credential: "new-owned-token",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.request("matrix/verify", {
          account: {
            ...result.account,
            homeserver: f.platform.url + "/different",
          },
          credential: "new-owned-token",
        })
      ).status,
    ).toBe(409);
    expect(await readFile(f.path, "utf8")).toBe(configured);
    expect(pins()).toEqual(before);
  } finally {
    await f.close();
  }
});

test("QQ failed apply retains the same server authorization for explicit retry within its original lifetime", async () => {
  let cb!: Parameters<typeof startQrConnect>[0];
  let scans = 0;
  const connector: typeof startQrConnect = (callbacks) => {
    cb = callbacks;
    scans++;
    callbacks.onQrDisplayed?.(
      "https://q.qq.com/qqbot/openclaw/connect.html?task_id=owned-retry",
    );
    return () => callbacks.onFailure(Error("fixture cancelled"));
  };
  const f = await settingsFixture(true, 300, connector);
  try {
    await f.login();
    const before = await readFile(f.path, "utf8");
    const qr = await (
      await f.request("connect/qq", {
        action: "start",
        account_id: "retry-scan",
      })
    ).json();
    await until(() => !!cb);
    cb.onSuccess([{ appId: "qq-app", appSecret: "owned-retained-credential" }]);
    await until(
      async () =>
        (await (await f.request("connect/qq?id=" + qr.id)).json()).state ===
        "authorized",
    );
    const submit = async () => {
      const v = editable(await f.app.view());
      return f.request("settings", {
        ...v,
        accounts: [
          {
            id: "retry-scan",
            platform: "qq",
            native_id: "qq-app",
            credential: "retained-secret",
          },
        ],
        qq_authorization: { id: qr.id, account_id: "retry-scan" },
      });
    };
    f.platform.tokenStall(true);
    const first = await submit();
    expect(first.status).toBe(200);
    expect((await first.json()).saved).toBe(true);
    await f.app.pending;
    expect(f.app.status().state).toBe("failed_recovered");
    expect(await readFile(f.path, "utf8")).toBe(before);
    const pins = f.app.store.db
      .prepare("SELECT * FROM identities ORDER BY account")
      .all();
    expect(
      f.app.store.db
        .prepare("SELECT ref FROM vault WHERE ref=?")
        .get("retained-secret"),
    ).toBeUndefined();
    const retained = await (await f.request("connect/qq?id=" + qr.id)).json();
    console.info(
      JSON.stringify({
        observation: "QQ failed apply authorization",
        state: retained.state,
        sameExpiry: retained.expires === qr.expires,
        scans,
        latest: f.app.status(),
      }),
    );
    expect(retained.state).toBe("authorized");
    expect(retained.expires).toBe(qr.expires);
    expect(JSON.stringify(retained)).not.toContain("owned-retained-credential");
    f.platform.tokenStall(false);
    const retry = await submit();
    expect(retry.status).toBe(200);
    expect((await retry.json()).saved).toBe(true);
    await f.app.pending;
    expect(f.app.status().applied).toBe(true);
    await until(
      async () =>
        (await (await f.request("connect/qq?id=" + qr.id)).json()).state ===
        "committed",
    );
    expect(scans).toBe(1);
    expect(
      await f.app.store.secret("retained-secret", "retry-scan", "platform"),
    ).toBe("owned-retained-credential");
    expect(
      f.app.store.db.prepare("SELECT * FROM identities ORDER BY account").all(),
    ).toEqual([{ account: "retry-scan", platform: "qq", native: "qq-app" }]);
    expect(pins).toEqual([]);
    expect(
      f.platform.calls
        .filter((c) => c.path === "/app/getAppAccessToken")
        .every((c) => c.body.clientSecret === "owned-retained-credential"),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test.each([false, true])(
  "QQ authorization expiry during accepted apply preserves its outcome and forbids credential replay (failure=%s)",
  async (failure) => {
    let cb!: Parameters<typeof startQrConnect>[0];
    const connector: typeof startQrConnect = (callbacks) => {
      cb = callbacks;
      return () => callbacks.onFailure(Error("fixture cancelled"));
    };
    const f = await settingsFixture(true, failure ? 300 : 1500, connector, 150);
    let stage = "login";
    try {
      await f.login();
      const qr = await (
        await f.request("connect/qq", {
          action: "start",
          account_id: "expires-scan",
        })
      ).json();
      await until(() => !!cb);
      cb.onSuccess([
        { appId: "qq-app", appSecret: "owned-expiring-credential" },
      ]);
      await until(
        async () =>
          (await (await f.request("connect/qq?id=" + qr.id)).json()).state ===
          "authorized",
      );
      const v = editable(await f.app.view());
      v.accounts = [
        {
          id: "expires-scan",
          platform: "qq",
          native_id: "qq-app",
          credential: "expires-secret",
        },
      ];
      const secrets = [];
      if (failure) f.platform.tokenStall(true);
      else {
        v.accounts.push({
          id: "slow-matrix",
          platform: "matrix",
          native_id: "@post:fixture",
          homeserver: f.platform.url,
          credential: "slow-matrix-secret",
        });
        secrets.push({
          ref: "slow-matrix-secret",
          account: "slow-matrix",
          kind: "platform",
          value: "owned-slow-matrix",
        });
        f.platform.delayWhoami(300);
      }
      stage = "submit";
      const ack = await (
        await f.request("settings", {
          ...v,
          secrets,
          qq_authorization: { id: qr.id, account_id: "expires-scan" },
        })
      ).json();
      expect(ack.saved).toBe(true);
      expect(ack.applied).toBe(false);
      stage = "await expiry";
      await until(
        async () =>
          (await (await f.request("connect/qq?id=" + qr.id)).json()).state ===
          "expired",
      );
      expect(f.app.status().busy).toBe(true);
      stage = "await apply";
      await f.app.pending;
      expect(f.app.status().applied).toBe(!failure);
      expect(f.app.status().saved).toBe(!failure);
      stage = "read expired";
      const expired = await (await f.request("connect/qq?id=" + qr.id)).json();
      expect(expired.state).toBe("expired");
      expect(expired.expires).toBe(qr.expires);
      expect(JSON.stringify(expired)).not.toContain(
        "owned-expiring-credential",
      );
      if (!failure)
        expect(
          await f.app.store.secret(
            "expires-secret",
            "expires-scan",
            "platform",
          ),
        ).toBe("owned-expiring-credential");
      stage = "reject replay";
      expect(
        (
          await f.request("settings", {
            ...editable(await f.app.view()),
            accounts: v.accounts,
            qq_authorization: { id: qr.id, account_id: "expires-scan" },
          })
        ).status,
      ).toBe(503);
    } catch (error) {
      throw new Error("expiry apply stage: " + stage, { cause: error });
    } finally {
      await f.close();
    }
  },
);

test.each(["cancel", "logout"])(
  "QQ %s during accepted apply invalidates retry authorization without undoing the captured save",
  async (action) => {
    let cb!: Parameters<typeof startQrConnect>[0];
    const f = await settingsFixture(true, 1500, (callbacks) => {
      cb = callbacks;
      return () => callbacks.onFailure(Error("owned cancellation"));
    });
    try {
      await f.login();
      const qr = await (
        await f.request("connect/qq", {
          action: "start",
          account_id: "cancel-accepted",
        })
      ).json();
      await until(() => !!cb);
      cb.onSuccess([{ appId: "qq-app", appSecret: "owned-cancel-accepted" }]);
      await until(
        async () =>
          (await (await f.request("connect/qq?id=" + qr.id)).json()).state ===
          "authorized",
      );
      const v = editable(await f.app.view());
      v.accounts = [
        {
          id: "cancel-accepted",
          platform: "qq",
          native_id: "qq-app",
          credential: "cancel-secret",
        },
        {
          id: "slow-matrix",
          platform: "matrix",
          native_id: "@post:fixture",
          homeserver: f.platform.url,
          credential: "slow-matrix-secret",
        },
      ];
      f.platform.delayWhoami(300);
      const ack = await (
        await f.request("settings", {
          ...v,
          secrets: [
            {
              ref: "slow-matrix-secret",
              account: "slow-matrix",
              kind: "platform",
              value: "owned-matrix",
            },
          ],
          qq_authorization: { id: qr.id, account_id: "cancel-accepted" },
        })
      ).json();
      expect(ack.saved).toBe(true);
      expect(ack.applied).toBe(false);
      expect(f.app.status().busy).toBe(true);
      const response =
        action === "logout"
          ? await f.request("logout", {})
          : await f.request("connect/qq", { action: "cancel", id: qr.id });
      expect(response.status).toBe(200);
      await response.json();
      await f.app.pending;
      expect(f.app.status().applied).toBe(true);
      expect(f.app.status().saved).toBe(true);
      expect(
        await f.app.store.secret(
          "cancel-secret",
          "cancel-accepted",
          "platform",
        ),
      ).toBe("owned-cancel-accepted");
      if (action === "logout") {
        expect((await f.request("connect/qq?id=" + qr.id)).status).toBe(401);
        await f.login();
        expect((await f.request("connect/qq?id=" + qr.id)).status).toBe(401);
      } else {
        const cancelled = await (
          await f.request("connect/qq?id=" + qr.id)
        ).json();
        expect(cancelled.state).toBe("cancelled");
        expect(cancelled.expires).toBe(qr.expires);
        expect(
          (
            await f.request("settings", {
              ...editable(await f.app.view()),
              qq_authorization: { id: qr.id, account_id: "cancel-accepted" },
            })
          ).status,
        ).toBe(503);
      }
    } finally {
      await f.close();
    }
  },
);
