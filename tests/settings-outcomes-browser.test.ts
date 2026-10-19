import { test, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { settingsFixture } from "./fixtures/settings";
import { until } from "./fixtures/state";
import type { startQrConnect } from "@tencent-connect/qqbot-connector";

// Optional explicit Chromium gate; actual packaged UI, owned native SDK endpoints,
// callbacks and HOME supplied by the ordinary test runner, no provider enrollment.
test.skipIf(!process.env.POST_BROWSER_CHECK)(
  "browser distinguishes unsaved retirement and retains QQ authorization through failed apply and explicit retry",
  async () => {
    let callback!: Parameters<typeof startQrConnect>[0],
      scans = 0;
    const connector: typeof startQrConnect = (cb) => {
      callback = cb;
      scans++;
      cb.onQrDisplayed?.(
        "https://q.qq.com/qqbot/openclaw/connect.html?task_id=owned-outcome",
      );
      return () => cb.onFailure(Error("owned cancelled"));
    };
    const f = await settingsFixture(
      true,
      300,
      connector,
      undefined,
      resolve("dist/web"),
    );
    const env = {
      ...process.env,
      AGENT_BROWSER_SESSION: "post-outcome-" + randomBytes(6).toString("hex"),
    };
    const exec = promisify(execFile);
    async function browser(args: string[]) {
      try {
        return (
          await exec("agent-browser", args, { env, timeout: 10000 })
        ).stdout.trim();
      } catch {
        throw Error("Owned browser action failed: " + args[0]);
      }
    }
    async function evaluate(code: string): Promise<any> {
      let value: any = await browser(["eval", code]);
      for (let n = 0; n < 3 && typeof value === "string"; n++) {
        try {
          value = JSON.parse(value);
        } catch {
          break;
        }
      }
      return value;
    }
    async function click(name: string) {
      await evaluate(
        "Promise.all(document.getAnimations().filter(a=>a.playState==='running').map(a=>a.finished.catch(()=>{})))",
      );
      return browser([
        "find",
        "role",
        "button",
        "click",
        "--name",
        name,
        "--exact",
      ]);
    }
    const fill = (id: string, value: string) =>
      browser(["fill", "#" + id, value]);
    const wait = (fn: string) => browser(["wait", "--fn", fn]);
    let release!: () => void;
    try {
      await browser([
        "--allowed-domains",
        "127.0.0.1",
        "open",
        f.config.settings.origin,
      ]);
      await fill("password", "owned-fixture-password");
      await click("登录");
      await wait("document.body.textContent.includes('注册 agent')");
      const before = await readFile(f.path, "utf8"),
        owner = f.app.store.owner;
      f.app.app.service!.track(new Promise<void>((r) => (release = r)));
      await click("＋ 注册 agent");
      await fill("agent-id", "outcomes");
      await fill("agent-name", "Owned outcomes");
      await fill("register-receiver", f.receiver.url);
      await fill("register-secret", "owned-receiver");
      await click("保存 agent");
      await wait(
        "document.body.textContent.includes('尚未保存，正在停止旧连接')",
      );
      expect(
        await evaluate(
          "document.body.textContent.includes('已保存，正在连接')",
        ),
      ).toBe(false);
      expect(f.app.status().saved).toBe(false);
      expect(await readFile(f.path, "utf8")).toBe(before);
      expect(f.app.store.owner).toBe(owner);
      expect(owner.closed).toBe(false);
      release();
      await f.app.pending;
      expect(await readFile(f.path, "utf8")).toBe(before);
      await browser(["press", "Escape"]);
      await wait("!document.querySelector('[role=dialog]')");
      // The rejected proposal remains explicit; this new click is the only retry.
      await click("＋ 注册 agent");
      await fill("agent-id", "outcomes");
      await fill("agent-name", "Owned outcomes");
      await fill("register-receiver", f.receiver.url);
      await fill("register-secret", "owned-receiver");
      await click("保存 agent");
      await wait("!document.querySelector('[role=dialog]')");
      await until(() => !f.app.status().busy);
      await click("绑定第一个账号");
      await click("＋ 新建账号");
      await click("扫码连接 QQ");
      await wait("!!document.querySelector('img[alt=\"QQ 账号授权二维码\"]')");
      callback.onSuccess([
        { appId: "qq-app", appSecret: "owned-retry-browser-credential" },
      ]);
      await wait("document.body.textContent.includes('已授权机器人')");
      await click("下一步");
      await browser(["click", "details:has(#manual) > summary"]);
      await fill("manual", "qq-group");
      await click("添加到草稿");
      await click("下一步");
      await click("下一步");
      f.platform.tokenStall(true);
      await click("保存并应用");
      await wait("document.body.textContent.includes('已保留账号和聊天草稿')");
      expect(f.app.status().state).toBe("failed_recovered");
      expect(
        await evaluate(
          "!!document.querySelector('[role=dialog]') && document.body.textContent.includes('已授权机器人') && !document.querySelector('#next').disabled",
        ),
      ).toBe(true);
      expect(f.app.config.accounts).toEqual([]);
      f.platform.tokenStall(false);
      await click("下一步");
      await click("下一步");
      await click("下一步");
      await click("保存并应用");
      await wait("!document.querySelector('[role=dialog]')");
      await until(() => !f.app.status().busy);
      expect(f.app.status().applied).toBe(true);
      expect(scans).toBe(1);
      const account = f.app.config.accounts[0];
      expect(
        await f.app.store.secret(account.credential, account.id, "platform"),
      ).toBe("owned-retry-browser-credential");
      expect(
        f.platform.calls
          .filter((c) => c.path === "/app/getAppAccessToken")
          .every(
            (c) => c.body.clientSecret === "owned-retry-browser-credential",
          ),
      ).toBe(true);
      expect(f.platform.sendCount).toBe(0);
    } finally {
      release?.();
      try {
        await browser(["close"]);
      } catch {}
      await f.close();
    }
  },
  45000,
);
