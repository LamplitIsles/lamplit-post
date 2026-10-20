import { test, expect } from "vitest";
import { settingsFixture } from "./fixtures/settings";
import { until } from "./fixtures/state";

test.each([1500, 30000])(
  "explicit QQ metadata timeout retains local candidates and retires native I/O (native budget %s)",
  async (budget) => {
    const f = await settingsFixture(false, budget);
    try {
      await f.login();
      f.platform.delayQQMetadata(budget === 1500 ? 2000 : 11500);
      const start = performance.now();
      const response = await f.request("discover", { account_id: "qq-main" });
      const result = await response.json();
      expect(response.status).toBe(200);
      expect(result.items.some((c: any) => c.native_id === "qq-group")).toBe(
        true,
      );
      expect(performance.now() - start).toBeLessThan(
        Math.min(budget, 8000) + 1000,
      );
      await until(() => f.platform.aborts === 1);
      expect(f.app.store.owner.closed).toBe(false);
      expect(f.receiver.attempts).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

test("disconnecting an explicit metadata refresh retires its native request before ownership closes", async () => {
  const f = await settingsFixture();
  try {
    const login = await f.login();
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const origin = f.config.settings.origin;
    const csrf = (
      await (
        await fetch(origin + "/api/session", { headers: { Cookie: cookie } })
      ).json()
    ).csrf;
    f.platform.delayQQMetadata(2000);
    const controller = new AbortController();
    const request = fetch(origin + "/api/discover", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/json",
        "X-Post-CSRF": csrf,
      },
      body: JSON.stringify({ account_id: "qq-main" }),
    }).catch(() => null);
    await until(() => f.platform.calls.some((c) => c.path.endsWith("/info")));
    controller.abort();
    expect(await request).toBeNull();
    await until(() => f.platform.aborts === 1);
    expect(f.app.store.owner.closed).toBe(false);
    await f.app.stop();
    expect(f.app.store.owner.closed).toBe(true);
  } finally {
    await f.close();
  }
});
