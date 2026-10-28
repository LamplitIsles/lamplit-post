import { test, expect } from "vitest";
import { resolve } from "node:path";
import { settingsFixture } from "./fixtures/settings";
import { until } from "./fixtures/state";
import type { startQrConnect } from "@tencent-connect/qqbot-connector";

// Opt-in browser gate uses only the test-owned loopback fixture and browser HOME.
async function openBrowser(
  f: Awaited<ReturnType<typeof settingsFixture>>,
  width: number,
  height: number,
) {
  const { chromium } = await import(process.env.POST_PLAYWRIGHT_MODULE!);
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.POST_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin",
      HOME: f.state.dir,
      XDG_CACHE_HOME: f.state.dir,
      XDG_CONFIG_HOME: f.state.dir,
    },
  });
  const page = await browser.newPage({
    viewport: { width, height },
    reducedMotion: "reduce",
  });
  await page.route("**/*", (route: any) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
  return { browser, page };
}
async function startAccount(page: any, origin: string, receiver: string) {
  await page.goto(origin);
  await page.locator("#password").fill("owned-fixture-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page
    .getByRole("button", { name: "＋ 注册 agent", exact: true })
    .click();
  await page.locator("#agent-id").fill("fixture");
  await page.locator("#agent-name").fill("Fixture");
  await page.locator("#register-receiver").fill(receiver);
  await page.locator("#register-secret").fill("fixture-receiver");
  await page.getByRole("button", { name: "保存 agent", exact: true }).click();
  await page
    .getByRole("button", { name: "绑定第一个账号", exact: true })
    .click();
  await page.getByRole("button", { name: "＋ 新建账号", exact: true }).click();
}
test.skipIf(!process.env.POST_PLAYWRIGHT_MODULE)(
  "QQ connects before discovering and explicitly granting a private conversation",
  async () => {
    let callback!: Parameters<typeof startQrConnect>[0];
    const connector: typeof startQrConnect = (cb) => {
      callback = cb;
      cb.onQrDisplayed?.(
        "https://q.qq.com/qqbot/openclaw/connect.html?task_id=fixture",
      );
      return () => cb.onFailure(Error("fixture cancelled"));
    };
    const f = await settingsFixture(
      true,
      1500,
      connector,
      undefined,
      resolve("dist/web"),
    );
    const { browser, page } = await openBrowser(f, 390, 844);
    try {
      await startAccount(page, f.config.settings.origin, f.receiver.url);
      await page
        .getByRole("button", { name: "扫码连接 QQ", exact: true })
        .click();
      await page.locator('img[alt="QQ 账号授权二维码"]').waitFor();
      callback.onSuccess([
        { appId: "fixture-app", appSecret: "fixture-secret" },
      ]);
      await page.getByText("尚未保存连接", { exact: false }).waitFor();
      await page
        .getByRole("button", { name: "保存并连接", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "查找聊天", exact: true })
        .waitFor();
      expect(f.app.status().applied).toBe(true);
      expect(f.app.config.accounts).toHaveLength(1);
      expect(f.app.config.bindings[0].scopes).toHaveLength(0);
      await page.getByRole("button", { name: "稍后完成", exact: true }).click();
      await page.locator('[role="dialog"]').waitFor({ state: "hidden" });
      expect(f.app.config.accounts).toHaveLength(1);
      await page.locator(".binding-details > summary").click();
      await page.getByRole("button", { name: "编辑绑定", exact: true }).click();
      await page
        .getByRole("button", { name: "保存并连接", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "查找聊天", exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "读取可用聊天 / 重试", exact: true })
        .click();
      await page.getByText("本机尚无候选聊天", { exact: false }).waitFor();
      await page.setViewportSize({ width: 390, height: 480 });
      await expect
        .poll(async () => {
          const footer = await page.locator("#next").boundingBox();
          return Boolean(
            footer && footer.y >= 0 && footer.y + footer.height <= 480,
          );
        })
        .toBe(true);
      if (process.env.POST_UI_EVIDENCE)
        await page.screenshot({
          path: resolve(process.env.POST_UI_EVIDENCE, "qq-short.png"),
        });
      await page.setViewportSize({ width: 390, height: 844 });
      f.platform.sendQQ("C2C_MESSAGE_CREATE", "fixture", {
        id: "fixture-message",
        group_id: undefined,
        group_openid: undefined,
        author: { id: "fixture-peer" },
      });
      await until(
        () =>
          f.app.store.db.prepare("SELECT count(*) n FROM messages").get()!.n ===
          1,
      );
      expect(f.receiver.attempts).toEqual([]);
      await page
        .getByRole("button", { name: "读取可用聊天 / 重试", exact: true })
        .click();
      await page
        .locator('input[type="checkbox"], button[role="checkbox"]')
        .first()
        .click();
      await page.locator("#next").click();
      await page
        .getByRole("heading", { name: "授权聊天", exact: true })
        .waitFor();
      await page.locator("#wake-direct").click();
      await page.locator("#next").click();
      await page
        .getByRole("button", { name: "保存聊天授权", exact: true })
        .click();
      await page.locator('[role="dialog"]').waitFor({ state: "hidden" });
      expect(f.app.config.bindings[0].scopes).toHaveLength(1);
      expect(f.app.config.bindings[0].scopes[0].senders).toEqual([
        "fixture-peer",
      ]);
      expect(f.app.config.bindings[0].wake.direct).toBe(true);
    } finally {
      await browser.close();
      await f.close();
    }
  },
  45000,
);

test.skipIf(!process.env.POST_PLAYWRIGHT_MODULE)(
  "Matrix saves and connects before discovering and granting joined rooms",
  async () => {
    const f = await settingsFixture(
      true,
      1500,
      undefined,
      undefined,
      resolve("dist/web"),
    );
    const { browser, page } = await openBrowser(f, 1280, 900);
    try {
      await startAccount(page, f.config.settings.origin, f.receiver.url);
      await page.locator("#platform").selectOption("matrix");
      await page.locator("#native").fill("@post:fixture");
      await page.locator("#homeserver").fill(f.platform.url);
      await page.locator("#credential").fill("test-matrix-platform-secret");
      await page.getByRole("button", { name: "验证账号", exact: true }).click();
      await page
        .getByText("账号已验证，可以保存并连接。", { exact: true })
        .waitFor();
      expect(f.app.config.accounts).toHaveLength(0);
      await page
        .getByRole("button", { name: "保存并连接", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "查找聊天", exact: true })
        .waitFor();
      expect(f.app.status().applied).toBe(true);
      expect(f.app.config.bindings[0].scopes).toHaveLength(0);
      let releaseDiscovery!: () => void;
      const discoveryGate = new Promise<void>((resolve) => {
        releaseDiscovery = resolve;
      });
      await page.route("**/api/discover", async (route: any) => {
        await discoveryGate;
        await route.continue();
      });
      await page
        .getByRole("button", { name: "读取可用聊天 / 重试", exact: true })
        .click();
      await page
        .getByRole("status")
        .filter({ hasText: "正在读取聊天…" })
        .waitFor();
      expect(await page.locator("#next").innerText()).toBe("正在读取聊天…");
      releaseDiscovery();
      await page.getByText("!room:fixture", { exact: false }).first().waitFor();
      if (process.env.POST_UI_EVIDENCE)
        await page.screenshot({
          path: resolve(process.env.POST_UI_EVIDENCE, "matrix-desktop.png"),
        });
      await page
        .locator('input[type="checkbox"], button[role="checkbox"]')
        .first()
        .click();
      await page.locator("#next").click();
      await page.locator("#next").click();
      await page
        .getByRole("button", { name: "保存聊天授权", exact: true })
        .click();
      await page.locator('[role="dialog"]').waitFor({ state: "hidden" });
      expect(f.app.config.bindings[0].scopes).toHaveLength(1);
      expect(f.app.config.bindings[0].scopes[0].native_id).toBe(
        "!room:fixture",
      );
      const savedScopes = structuredClone(f.app.config.bindings[0].scopes);
      const savedWake = structuredClone(f.app.config.bindings[0].wake);
      await page.locator(".binding-details > summary").click();
      await page.getByRole("button", { name: "编辑绑定", exact: true }).click();
      await page.locator("#account-name").fill("Renamed fixture");
      await page
        .getByRole("button", { name: "保存并连接", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "查找聊天", exact: true })
        .waitFor();
      expect(f.app.config.bindings[0].scopes).toEqual(savedScopes);
      expect(f.app.config.bindings[0].wake).toEqual(savedWake);
      await page.getByRole("button", { name: "稍后完成", exact: true }).click();
    } finally {
      await browser.close();
      await f.close();
    }
  },
  45000,
);

test.skipIf(!process.env.POST_PLAYWRIGHT_MODULE)(
  "a new account first save preserves another agent's account and chat grants",
  async () => {
    let callback!: Parameters<typeof startQrConnect>[0];
    const connector: typeof startQrConnect = (cb) => {
      callback = cb;
      cb.onQrDisplayed?.(
        "https://q.qq.com/qqbot/openclaw/connect.html?task_id=fixture",
      );
      return () => cb.onFailure(Error("fixture cancelled"));
    };
    const f = await settingsFixture(
      false,
      1500,
      connector,
      undefined,
      resolve("dist/web"),
      (config) => ({
        ...config,
        accounts: config.accounts.filter((a) => a.platform === "matrix"),
        agents: [
          ...config.agents,
          {
            id: "other",
            name: "Other",
            receiver_url: config.agents[0]!.receiver_url,
            receiver_credential: "other-receiver",
          },
        ],
        bindings: [
          {
            ...config.bindings[0]!,
            agent_id: "other",
            account_ids: ["matrix-main"],
            scopes: config.bindings[0]!.scopes.filter(
              (s) => s.account_id === "matrix-main",
            ),
          },
        ],
      }),
    );
    const { browser, page } = await openBrowser(f, 1280, 900);
    try {
      const before = structuredClone(f.app.config.bindings[0]);
      const account = structuredClone(f.app.config.accounts[0]);
      await page.goto(f.config.settings.origin);
      await page.locator("#password").fill("owned-fixture-password");
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page
        .getByRole("button", { name: "绑定第一个账号", exact: true })
        .click();
      await page
        .getByRole("button", { name: "＋ 新建账号", exact: true })
        .click();
      await page
        .getByRole("button", { name: "扫码连接 QQ", exact: true })
        .click();
      await page.locator('img[alt="QQ 账号授权二维码"]').waitFor();
      callback.onSuccess([
        { appId: "fixture-app", appSecret: "fixture-secret" },
      ]);
      await page.getByText("尚未保存连接", { exact: false }).waitFor();
      await page
        .getByRole("button", { name: "保存并连接", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "查找聊天", exact: true })
        .waitFor();
      expect(f.app.config.bindings.find((b) => b.agent_id === "other")).toEqual(
        before,
      );
      expect(f.app.config.accounts.find((a) => a.id === "matrix-main")).toEqual(
        account,
      );
      expect(
        f.app.config.bindings.find((b) => b.agent_id === "cfl")?.scopes,
      ).toEqual([]);
    } finally {
      await browser.close();
      await f.close();
    }
  },
  45000,
);

test.skipIf(!process.env.POST_PLAYWRIGHT_MODULE).each([200, 503])(
  "incomplete account-save response (%i) requires readback without replay",
  async (responseStatus) => {
    let callback!: Parameters<typeof startQrConnect>[0];
    const connector: typeof startQrConnect = (cb) => {
      callback = cb;
      cb.onQrDisplayed?.(
        "https://q.qq.com/qqbot/openclaw/connect.html?task_id=fixture",
      );
      return () => cb.onFailure(Error("fixture cancelled"));
    };
    const f = await settingsFixture(
      true,
      1500,
      connector,
      undefined,
      resolve("dist/web"),
    );
    const { browser, page } = await openBrowser(f, 390, 844);
    try {
      await startAccount(page, f.config.settings.origin, f.receiver.url);
      await page
        .getByRole("button", { name: "扫码连接 QQ", exact: true })
        .click();
      await page.locator('img[alt="QQ 账号授权二维码"]').waitFor();
      callback.onSuccess([
        { appId: "fixture-app", appSecret: "fixture-secret" },
      ]);
      await page.getByText("尚未保存连接", { exact: false }).waitFor();
      let posts = 0;
      let failSettingsRead = false;
      await page.route("**/api/settings", async (route: any) => {
        if (route.request().method() !== "POST")
          return failSettingsRead
            ? route.fulfill({ status: 503, body: "{}" })
            : route.continue();
        posts++;
        const response = await route.fetch();
        failSettingsRead = true;
        await route.fulfill({ response, status: responseStatus, body: "{}" });
      });
      await page
        .getByRole("button", { name: "保存并连接", exact: true })
        .click();
      await page
        .locator('[role="dialog"]')
        .getByRole("button", { name: "读取当前状态", exact: true })
        .waitFor();
      expect(await page.locator("#next").isDisabled()).toBe(true);
      await until(() => !f.app.status().busy);
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await page.locator('[role="dialog"]').waitFor({ state: "hidden" });
      await page
        .getByRole("button", { name: "＋ 注册 agent", exact: true })
        .click();
      await page.locator("#agent-id").fill("second");
      await page.locator("#agent-name").fill("Second");
      await page.locator("#register-receiver").fill(f.receiver.url);
      await page.locator("#register-secret").fill("fixture-receiver");
      await page
        .getByRole("button", { name: "保存 agent", exact: true })
        .click();
      await page
        .locator('[role="dialog"]')
        .getByText("上次保存结果尚未确认。请先读取当前状态。", { exact: true })
        .waitFor();
      expect(posts).toBe(1);
      await page
        .locator('[role="dialog"]')
        .getByRole("button", { name: "取消", exact: true })
        .click();
      await page
        .getByRole("button", { name: "绑定第一个账号", exact: true })
        .click();
      expect(await page.locator("#next").isDisabled()).toBe(true);
      let invalidStatus = true;
      await page.route("**/api/status", async (route: any) =>
        invalidStatus
          ? route.fulfill({ status: 200, body: "{}" })
          : route.continue(),
      );
      await page
        .locator('[role="dialog"]')
        .getByRole("button", { name: "读取当前状态", exact: true })
        .click();
      await expect
        .poll(() =>
          page
            .locator('[role="dialog"]')
            .getByRole("button", { name: "读取当前状态", exact: true })
            .isEnabled(),
        )
        .toBe(true);
      expect(await page.locator("#next").isDisabled()).toBe(true);
      failSettingsRead = false;
      await page
        .locator('[role="dialog"]')
        .getByRole("button", { name: "读取当前状态", exact: true })
        .click();
      await page
        .getByText("当前状态尚无法确认，请稍后重新读取。", { exact: true })
        .waitFor();
      expect(await page.locator("#next").isDisabled()).toBe(true);
      expect(posts).toBe(1);
      invalidStatus = false;
      await page
        .locator('[role="dialog"]')
        .getByRole("button", { name: "读取当前状态", exact: true })
        .click();
      await page.locator('[role="dialog"]').waitFor({ state: "hidden" });
      await page
        .getByText("已读取当前状态。请检查账号和授权后再决定下一步。", {
          exact: true,
        })
        .waitFor();
      expect(f.app.config.accounts).toHaveLength(1);
      expect(f.app.config.bindings[0].scopes).toHaveLength(0);
      expect(posts).toBe(1);
    } finally {
      await browser.close();
      await f.close();
    }
  },
  45000,
);
