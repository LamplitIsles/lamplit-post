import { test, expect } from "vitest";
import { resolve } from "node:path";
import { settingsFixture } from "./fixtures/settings";
import { until } from "./fixtures/state";

// Uses the existing test-owned Post and SDK fixtures; no real accounts or messages.
test.skipIf(!process.env.POST_PLAYWRIGHT_MODULE)(
  "account status refresh survives apply, temporary failure and recovery",
  async () => {
    const f = await settingsFixture(
      false,
      1500,
      undefined,
      undefined,
      resolve("dist/web"),
    );
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
      viewport: { width: 390, height: 844 },
    });
    let mode: "attention" | "unknown" | "unavailable" | "connected" =
      "attention";
    let initialSettings = true;
    const decorate = (accounts: any[]) =>
      accounts.map((account) =>
        account.account_id !== "qq-main"
          ? account
          : {
              ...account,
              state: mode === "connected" ? "connected" : "needs_attention",
              reason:
                mode === "connected" || mode === "unknown"
                  ? null
                  : "authentication_rejected",
              next_retry_at:
                mode === "connected" || mode === "unknown"
                  ? null
                  : Date.now() + 60000,
              backlog: [
                {
                  binding_id: f.config.bindings[0].id,
                  account_id: "qq-main",
                  pending: 3,
                  held: 1,
                  limit: 100,
                },
              ],
            },
      );
    try {
      await page.route("**/*", async (route: any) => {
        const url = new URL(route.request().url());
        if (url.hostname !== "127.0.0.1") return route.abort();
        if (url.pathname !== "/api/status" && url.pathname !== "/api/settings")
          return route.continue();
        if (route.request().method() !== "GET") return route.continue();
        if (url.pathname === "/api/status" && mode === "unavailable")
          return route.fulfill({ status: 503, json: { error: "unavailable" } });
        const response = await route.fetch();
        if (!response.ok()) return route.fulfill({ response });
        const body = await response.json();
        if (url.pathname === "/api/status")
          body.accounts = decorate(body.accounts);
        else {
          body.account_status = decorate(body.account_status);
          // Exercise followApply's status merge without altering the real configuration.
          if (initialSettings) body.busy = true;
          initialSettings = false;
        }
        return route.fulfill({ response, json: body });
      });
      await page.goto(f.config.settings.origin);
      await page.locator("#password").fill("owned-fixture-password");
      await page.getByRole("button", { name: "登录", exact: true }).click();
      const accounts = page.locator(".account-identity");
      await expect.poll(() => accounts.count()).toBe(2);
      const qq = accounts.filter({ hasText: "qq-main" });
      const matrix = accounts.filter({ hasText: "matrix-main" });
      await expect.poll(() => qq.innerText()).toContain("需要检查");
      expect(await qq.innerText()).toContain("请检查账号凭据");
      expect(await qq.innerText()).toContain("待投递 3 条");
      expect(await matrix.innerText()).toContain("已连接");
      expect(await page.locator(".account-choice").count()).toBe(0);
      mode = "unknown";
      await expect
        .poll(() => qq.innerText(), { timeout: 10000 })
        .toContain("请检查账号及 Post 服务状态");
      expect(await qq.innerText()).not.toContain("下次尝试");
      mode = "unavailable";
      await expect
        .poll(() => qq.innerText(), { timeout: 10000 })
        .toContain("状态暂不可用");
      expect(await page.locator('[role="alert"]').allInnerTexts()).toContainEqual(
        expect.stringContaining("当前设置状态无法确认"),
      );
      mode = "connected";
      await expect
        .poll(() => qq.innerText(), { timeout: 10000 })
        .toContain("已连接");
      expect(await page.locator('[role="alert"]').count()).toBe(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    } finally {
      await browser.close();
      await f.close();
    }
  },
  35000,
);

test.skipIf(!process.env.POST_PLAYWRIGHT_MODULE)(
  "another administrator changes accounts without replacing an open draft",
  async () => {
    const f = await settingsFixture(
      false,
      1500,
      undefined,
      undefined,
      resolve("dist/web"),
    );
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
      viewport: { width: 390, height: 844 },
    });
    let simulated: "normal" | "changing" | "failed" | "degraded" = "normal";
    const editable = (view: any) => ({
      version: view.version,
      accounts: view.accounts.map(
        ({ hasCredential, ready, ...account }: any) => account,
      ),
      agents: view.agents.map(
        ({ hasCredential, hasToken, ...agent }: any) => agent,
      ),
      bindings: view.bindings.map((binding: any) => ({
        ...binding,
        scopes: binding.scopes.map(({ name, ...scope }: any) => scope),
      })),
    });
    try {
      await page.route("**/*", async (route: any) => {
        const url = new URL(route.request().url());
        if (url.hostname !== "127.0.0.1") return route.abort();
        if (url.pathname !== "/api/status" || simulated === "normal")
          return route.continue();
        const response = await route.fetch();
        const body = await response.json();
        if (simulated === "changing") body.busy = true;
        else if (simulated === "failed")
          Object.assign(body, {
            busy: false,
            state: "failed_recovered",
            applied: false,
          });
        else
          Object.assign(body, {
            busy: false,
            state: "applied",
            applied: false,
            ready: false,
          });
        return route.fulfill({ response, json: body });
      });
      await page.goto(f.config.settings.origin);
      await page.locator("#password").fill("owned-fixture-password");
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page
        .locator(".account-identity")
        .filter({ hasText: "matrix-main" })
        .waitFor();
      await page.locator(".binding-details > summary").click();
      await page.getByRole("button", { name: "编辑绑定", exact: true }).click();
      await page.locator("#account-name").fill("尚未保存的修改");

      // The fixture API has a separate authenticated session from the browser.
      await f.login();
      const original = editable(await f.app.view());
      const remove = editable(await f.app.view());
      remove.accounts = remove.accounts.filter(
        (account: any) => account.id !== "matrix-main",
      );
      for (const binding of remove.bindings) {
        binding.account_ids = binding.account_ids.filter(
          (id: string) => id !== "matrix-main",
        );
        binding.scopes = binding.scopes.filter(
          (scope: any) => scope.account_id !== "matrix-main",
        );
      }
      expect((await f.apply("settings", remove)).ok).toBe(true);
      await expect
        .poll(() => page.locator('[role="dialog"]').innerText(), {
          timeout: 10000,
        })
        .toContain("设置已在其他位置更改");
      expect(await page.locator("#account-name").inputValue()).toBe(
        "尚未保存的修改",
      );
      expect(await page.locator("#next").isDisabled()).toBe(true);
      if (process.env.POST_UI_EVIDENCE)
        await page.screenshot({
          path: resolve(
            process.env.POST_UI_EVIDENCE,
            "concurrent-stale-mobile.png",
          ),
          fullPage: true,
        });
      expect(
        await page
          .locator(".account-identity")
          .filter({ hasText: "matrix-main" })
          .innerText(),
      ).toContain("状态暂不可用");
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await page.getByRole("button", { name: "刷新设置", exact: true }).click();
      await expect
        .poll(() => page.locator(".account-identity").count())
        .toBe(1);

      const add = editable(await f.app.view());
      add.accounts.push(
        original.accounts.find((account: any) => account.id === "matrix-main"),
      );
      add.bindings = original.bindings;
      expect(
        (
          await f.apply("settings", {
            ...add,
            secrets: [
              {
                ref: "matrix-secret",
                account: "matrix-main",
                kind: "platform",
                value: "test-matrix-platform-secret",
              },
            ],
          })
        ).ok,
      ).toBe(true);
      await expect
        .poll(() => page.locator('[role="alert"]').allInnerTexts(), {
          timeout: 10000,
        })
        .toContainEqual(expect.stringContaining("设置已在其他位置更改"));
      await page.getByRole("button", { name: "刷新设置", exact: true }).click();
      await expect
        .poll(() => page.locator(".account-identity").count())
        .toBe(2);

      simulated = "changing";
      await expect
        .poll(() => page.locator('[role="alert"]').allInnerTexts(), {
          timeout: 10000,
        })
        .toContainEqual(expect.stringContaining("设置正在其他位置更改"));
      expect(
        await page.locator(".section-head").first().innerText(),
      ).not.toContain("设置已生效");
      simulated = "failed";
      await expect
        .poll(() => page.locator(".section-head").first().innerText(), {
          timeout: 10000,
        })
        .toContain("已恢复原设置");
      simulated = "degraded";
      await expect
        .poll(() => page.locator(".section-head").first().innerText(), {
          timeout: 10000,
        })
        .toContain("服务未就绪");
      await until(() => !f.app.status().busy);
    } finally {
      await browser.close();
      await f.close();
    }
  },
  60000,
);
