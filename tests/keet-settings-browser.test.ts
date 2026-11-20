import { test, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PNG } from "pngjs";
import { settingsFixture } from "./fixtures/settings";
import { until } from "./fixtures/state";

test.skipIf(!process.env.POST_PLAYWRIGHT_MODULE)(
  "Keet settings joins exact invitations, reconciles a pending link and saves native profile",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "post-keet-web-"));
    const runtime = join(root, "runtime");
    const identity = join(root, "identity");
    const launcher = join(
      runtime,
      "node_modules/bare-sidecar/prebuilds/linux-x64/bare",
    );
    const worker = resolve("tests/fixtures/keet-platform-worker.cjs");
    const statePath = join(identity, "fixture.json");
    const room = { type: "0", readable: true, writable: true, removed: false };
    let fixture: Awaited<ReturnType<typeof settingsFixture>> | undefined;
    let browser: any;
    try {
      await mkdir(identity, { mode: 0o700 });
      await mkdir(dirname(launcher), { recursive: true });
      await writeFile(
        launcher,
        "#!/bin/sh\nexec '" +
          process.execPath.replaceAll("'", "'\\''") +
          '\' "$@"\n',
        { mode: 0o700 },
      );
      await symlink(worker, join(runtime, "core-worker.bundle"));
      await writeFile(
        statePath,
        JSON.stringify({
          member: "fixture-keet-member",
          displayName: null,
          autoJoin: true,
          rooms: { initial: { ...room, name: "工作群" } },
          invites: [
            {
              kind: "group",
              room: "invited",
              peer: "inviter",
              name: "待加入的房间",
            },
            {
              kind: "direct",
              room: "private",
              peer: "peer",
              name: "测试联系人",
            },
          ],
          links: {
            "fixture-link": {
              seed: "fixture-seed",
              name: "链接邀请的房间",
              unrelatedRoom: "unrelated",
            },
          },
        }),
        { mode: 0o600 },
      );
      const hash = async (path: string) =>
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      fixture = await settingsFixture(
        false,
        3000,
        undefined,
        undefined,
        resolve("dist/web"),
        (config) => ({
          ...config,
          keet_runtime_dir: runtime,
          accounts: [
            {
              id: "keet-local",
              platform: "keet",
              name: "测试 Keet",
              native_id: "fixture-keet-member",
              identity_dir: identity,
            },
          ],
          bindings: config.bindings.slice(0, 1).map((binding) => ({
            ...binding,
            account_ids: ["keet-local"],
            scopes: [],
          })),
        }),
        {
          keet: {
            hashes: {
              bare: await hash(launcher),
              bundle: await hash(worker),
              addons: [],
            },
            swarming: false,
          },
        },
      );
      const { chromium } = await import(process.env.POST_PLAYWRIGHT_MODULE!);
      browser = await chromium.launch({
        headless: true,
        executablePath: process.env.POST_CHROMIUM_EXECUTABLE,
        args: ["--no-sandbox"],
        env: {
          HOME: root,
          XDG_CACHE_HOME: root,
          XDG_CONFIG_HOME: root,
          PATH: process.env.PATH || "/usr/bin:/bin",
        },
      });
      const page = await browser.newPage({
        viewport: { width: 390, height: 700 },
        reducedMotion: "reduce",
      });
      await page.route("**/*", (route: any) =>
        new URL(route.request().url()).hostname === "127.0.0.1"
          ? route.continue()
          : route.abort(),
      );
      const pageErrors: string[] = [];
      page.on("pageerror", (error: Error) => pageErrors.push(error.message));
      const button = (name: string) =>
        page.getByRole("button", { name, exact: true });
      const screenshot = async (name: string) => {
        if (process.env.POST_UI_EVIDENCE)
          await page.screenshot({
            path: resolve(process.env.POST_UI_EVIDENCE, name),
            animations: "disabled",
          });
      };
      await page.goto(fixture.config.settings.origin);
      await page.locator("#password").fill("owned-fixture-password");
      await button("登录").click();
      await button("管理 Keet · 测试 Keet").click();
      await page.getByText("待加入的房间", { exact: true }).waitFor();
      await screenshot("keet-invites-mobile.png");
      await button("加入并授权").click();
      await page.getByText("已加入房间。", { exact: true }).waitFor();
      await button("接受并授权").click();
      await expect.poll(async () => button("接受并授权").count()).toBe(0);
      await page
        .locator("#keet-link")
        .fill("https://keet.io/chat#fixture-link");
      await button("查看邀请").click();
      await page.getByText("链接邀请的房间", { exact: true }).waitFor();
      await button("加入并授权").click();
      await page
        .getByText("正在加入，请查询加入状态。", { exact: true })
        .waitFor();
      await page.locator("#keet-link").fill("keet://chat/fixture-link");
      await button("查看邀请").click();
      await page
        .getByText("正在加入，请查询加入状态。", { exact: true })
        .waitFor();
      await button("查询加入状态").click();
      await expect
        .poll(async () => button("查询加入状态").isEnabled())
        .toBe(true);
      expect(await button("加入并授权").count()).toBe(0);
      await screenshot("keet-pending-mobile.png");
      const native = JSON.parse(await readFile(statePath, "utf8"));
      expect(native.joins).toBe(1);
      native.links["fixture-link"].room = "exact";
      native.rooms.exact = { ...room, name: "链接邀请的房间" };
      await writeFile(statePath + ".test", JSON.stringify(native));
      await rename(statePath + ".test", statePath);
      await button("查询加入状态").click();
      await page.getByText("已加入房间", { exact: true }).waitFor();
      expect(JSON.parse(await readFile(statePath, "utf8")).joins).toBe(1);

      await button("Keet 资料").click();
      const picture = new PNG({ width: 2, height: 2 });
      picture.data.set([
        55, 89, 137, 255, 97, 142, 176, 255, 97, 142, 176, 255, 247, 198, 147,
        255,
      ]);
      await page.locator("#keet-avatar").setInputFiles({
        name: "avatar.png",
        mimeType: "image/png",
        buffer: PNG.sync.write(picture),
      });
      await page.getByAltText("新头像预览").waitFor();
      expect(await button("保存 Keet 资料").isEnabled()).toBe(false);
      await page.locator("#keet-nickname").fill("测试昵称");
      await page.setViewportSize({ width: 1280, height: 900 });
      await screenshot("keet-profile-preview-desktop.png");
      await button("保存 Keet 资料").click();
      const current = page.getByAltText("当前 Keet 头像");
      await current.waitFor();
      const saved = await current.getAttribute("src");
      await page.locator("#keet-nickname").fill("更新后的昵称");
      await button("保存 Keet 资料").click();
      await page.getByText("Keet 资料已保存。", { exact: true }).waitFor();
      expect(await current.getAttribute("src")).toBe(saved);
      expect(JSON.parse(await readFile(statePath, "utf8")).displayName).toBe(
        "更新后的昵称",
      );

      await button("已加入的聊天").click();
      await page.getByText("工作群", { exact: true }).waitFor();
      const firstRoom = page.locator(".keet-row").filter({ hasText: "工作群" });
      await firstRoom
        .getByRole("button", { name: "改名", exact: true })
        .click();
      await page.getByLabel("Post 中的聊天名称").fill("日常讨论");
      await button("保存名称").click();
      await page.getByText(/聊天名称已保存|名称已提交/).waitFor();
      await until(() => {
        const status = fixture!.app.status();
        return (
          status.applied &&
          !status.busy &&
          status.accounts.some(
            (account) =>
              account.account_id === "keet-local" &&
              account.state === "connected",
          )
        );
      }, 5000);
      await expect
        .poll(async () => button("重新读取聊天").isEnabled())
        .toBe(true);
      await button("重新读取聊天").click();
      await page.getByText("日常讨论", { exact: true }).waitFor();
      expect(fixture.app.config.bindings[0]!.scopes).toEqual([]);
      expect(pageErrors).toEqual([]);
    } finally {
      await browser?.close();
      await fixture?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  45000,
);
