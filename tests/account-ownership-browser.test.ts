import { test, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { readFile, mkdir } from "node:fs/promises";
import { settingsFixture } from "./fixtures/settings";

test.skipIf(!process.env.POST_BROWSER_CHECK)(
  "actual agent home/picker isolate owned accounts; zero grants, cancel, revoke and explicit deletion preserve ownership",
  async () => {
    const f = await settingsFixture(
      false,
      1500,
      undefined,
      undefined,
      resolve("dist/web"),
      (config) => ({
        ...config,
        accounts: config.accounts.map((a) => ({
          ...a,
          name: a.platform === "qq" ? "Owner A QQ" : "Owner B Matrix",
        })),
        agents: [
          ...config.agents.map((a) => ({ ...a, name: "Owner A" })),
          {
            id: "other",
            name: "Owner B",
            receiver_url: config.agents[0]!.receiver_url,
            receiver_credential: "other-receiver",
          },
        ],
        bindings: [
          { ...config.bindings[0]!, account_ids: ["qq-main"], scopes: [] },
          {
            ...config.bindings[0]!,
            id: "other-binding",
            agent_id: "other",
            account_ids: ["matrix-main"],
            scopes: config.bindings[0]!.scopes.filter(
              (s) => s.account_id === "matrix-main",
            ),
          },
        ],
      }),
    );
    const env = {
      ...process.env,
      AGENT_BROWSER_SESSION: "ownership-" + randomBytes(5).toString("hex"),
    };
    const exec = promisify(execFile);
    const browser = async (...args: string[]) =>
      (
        await exec("agent-browser", args, { env, timeout: 10000 })
      ).stdout.trim();
    const click = (name: string) =>
      browser("find", "role", "button", "click", "--name", name, "--exact");
    const wait = (code: string) =>
      browser("wait", "--fn", code, "--timeout", "4000");
    const value = async (code: string) => {
      let result: any = await browser("eval", code);
      for (let i = 0; i < 3 && typeof result === "string"; i++) {
        try {
          result = JSON.parse(result);
        } catch {
          break;
        }
      }
      return result;
    };
    const shot = async (name: string) => {
      if (!process.env.POST_OWNERSHIP_EVIDENCE) return;
      await mkdir(process.env.POST_OWNERSHIP_EVIDENCE, { recursive: true });
      await browser(
        "screenshot",
        resolve(process.env.POST_OWNERSHIP_EVIDENCE, name + ".png"),
      );
    };
    try {
      await browser(
        "--allowed-domains",
        "127.0.0.1",
        "open",
        f.config.settings.origin,
      );
      await browser("fill", "#password", "owned-fixture-password");
      await click("登录");
      await wait(
        "document.querySelector('main h1')?.textContent.includes('Owner A')",
      );
      const before = await readFile(f.path, "utf8");
      expect
        .soft(await value("document.querySelector('.bindings').innerText"))
        .not.toContain("Owner B Matrix");
      expect(
        await value("document.querySelector('.bindings').innerText"),
      ).toContain("Owner A QQ");
      expect(
        await value("document.querySelector('.bindings').innerText"),
      ).toContain("未授权聊天");
      await click("＋ 绑定账号");
      expect
        .soft(await value("document.querySelector('[role=dialog]').innerText"))
        .not.toContain("Owner B Matrix");
      await browser("press", "Escape");
      await wait("!document.querySelector('[role=dialog]')");
      expect(await readFile(f.path, "utf8")).toBe(before);
      // Follow the public agent switch; do not read hidden Svelte state.
      await browser(
        "find",
        "role",
        "button",
        "click",
        "--name",
      "O Owner B",
        "--exact",
      );
      await wait(
        "document.querySelector('main h1')?.textContent.includes('Owner B')",
      );
      expect
        .soft(await value("document.querySelector('.bindings').innerText"))
        .not.toContain("Owner A QQ");
      await click("＋ 绑定账号");
      expect
        .soft(await value("document.querySelector('[role=dialog]').innerText"))
        .not.toContain("Owner A QQ");
      await browser("press", "Escape");
      await wait("!document.querySelector('[role=dialog]')");
      await browser(
        "eval",
        "document.querySelector('.binding-details').open=true",
      );
      const canRevoke = await value(
        "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='撤销聊天授权')",
      );
      expect.soft(canRevoke).toBe(true);
      if (!canRevoke) return; // The old static artifact is a red control, not a successful revoke proof.
      await click("撤销聊天授权");
      await click("确认撤销");
      await wait(
        "!document.querySelector('[role=dialog]') && document.querySelector('.bindings').textContent.includes('未授权聊天')",
      );
      await f.login();
      const v = await f.app.view();
      expect(v.accounts).toHaveLength(2);
      expect(
        v.bindings.find((b) => b.agent_id === "other")!.account_ids,
      ).toEqual(["matrix-main"]);
      expect(v.bindings.find((b) => b.agent_id === "other")!.scopes).toEqual(
        [],
      );
      expect(v.bindings.find((b) => b.agent_id === "cfl")!.account_ids).toEqual(
        ["qq-main"],
      );
      for (const width of [1100, 390]) {
        await browser("set", "viewport", String(width), "850");
        expect(
          await value("document.documentElement.scrollWidth<=innerWidth"),
        ).toBe(true);
        await shot("owner-b-zero-grants-" + width);
      }
      await browser(
        "eval",
        "document.querySelector('.binding-details').open=true",
      );
      await click("删除账号 Owner B Matrix");
      await click("取消");
      await wait("!document.querySelector('[role=dialog]')");
      expect((await f.app.view()).accounts).toHaveLength(2);
      const pins = f.app.store.db
        .prepare("SELECT * FROM identities ORDER BY account")
        .all();
      await click("删除账号 Owner B Matrix");
      await click("确认删除账号");
      await wait(
        "!document.querySelector('[role=dialog]') && !document.querySelector('.bindings').textContent.includes('Owner B Matrix')",
      );
      expect((await f.app.view()).accounts.map((a) => a.id)).toEqual([
        "qq-main",
      ]);
      expect(
        f.app.store.db
          .prepare("SELECT * FROM identities ORDER BY account")
          .all(),
      ).toEqual(pins);
      expect(f.platform.sendCount).toBe(0);
    } finally {
      await browser("close").catch(() => {});
      await f.close();
    }
  },
);
