import { test, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { settingsFixture } from "./fixtures/settings";
import { until } from "./fixtures/state";

test.skipIf(!process.env.POST_BROWSER_CHECK)(
  "native QQ group/private labels survive selection, save and reload with honest unavailable-name fallback",
  async () => {
    const f = await settingsFixture(
      false,
      1500,
      undefined,
      undefined,
      resolve("dist/web"),
    );
    const tool = async (name: string, args: unknown) => {
      const response = await fetch(f.app.app.http!.url + "/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + f.state.token,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      return (await response.json()).result;
    };
    const env = {
      ...process.env,
      AGENT_BROWSER_SESSION: "qq-label-" + randomBytes(5).toString("hex"),
    };
    const exec = promisify(execFile);
    const browser = async (...args: string[]) =>
      (
        await exec("agent-browser", args, { env, timeout: 10000 })
      ).stdout.trim();
    async function evaluate(code: string): Promise<any> {
      let value: any = await browser("eval", code);
      for (let i = 0; i < 3 && typeof value === "string"; i++) {
        try {
          value = JSON.parse(value);
        } catch {
          break;
        }
      }
      return value;
    }
    const click = (name: string) =>
      browser("find", "role", "button", "click", "--name", name, "--exact");
    const wait = (code: string) =>
      browser("wait", "--fn", code, "--timeout", "4000");
    const shot = async (name: string) => {
      if (!process.env.POST_AVAILABLE_EVIDENCE) return;
      await mkdir(process.env.POST_AVAILABLE_EVIDENCE, { recursive: true });
      await evaluate("document.fonts.ready");
      await browser(
        "screenshot",
        resolve(process.env.POST_AVAILABLE_EVIDENCE, name + ".png"),
      );
    };
    try {
      await f.login();
      const v = await f.app.view();
      const saved = await f.apply("settings", {
        version: v.version,
        accounts: v.accounts.map(({ hasCredential, ready, ...a }) => a),
        agents: v.agents.map(({ hasCredential, hasToken, ...a }) => a),
        bindings: v.bindings.map((b) => ({
          ...b,
          scopes: b.scopes
            .filter((s) => s.account_id !== "qq-main")
            .map(({ name, ...s }) => s),
        })),
      });
      expect(saved.status).toBe(200);
      f.platform.qqGroupName("label-group", "Owned QQ group");
      f.platform.qqGroupName("label-unknown", null);
      f.platform.sendQQ("GROUP_AT_MESSAGE_CREATE", "owned named group", {
        group_id: "label-group",
        group_openid: "label-group",
      });
      await until(
        () =>
          !!f.app.store.db
            .prepare("SELECT id FROM conversations WHERE native=?")
            .get("label-group"),
      );
      f.platform.sendQQ("C2C_MESSAGE_CREATE", "owned named peer", {
        group_id: undefined,
        group_openid: undefined,
        author: { id: "label-peer", username: "Owned QQ peer" },
      });
      f.platform.sendQQ("C2C_MESSAGE_CREATE", "owned unavailable name", {
        group_id: undefined,
        group_openid: undefined,
        author: { id: "label-unknown" },
      });
      await until(
        () =>
          f.app.store.db
            .prepare("SELECT count(*) n FROM messages WHERE account='qq-main'")
            .get()!.n === 3,
      );
      expect(f.receiver.attempts).toEqual([]);
      expect(f.platform.calls.some((c) => c.path.endsWith("/info"))).toBe(true);
      const observed = f.app.store.db
        .prepare(
          "SELECT id FROM conversations WHERE account='qq-main' AND native='label-peer'",
        )
        .get()!;
      expect(
        (
          await tool("get_conversation", {
            account_id: "qq-main",
            conversation_name: "Owned QQ peer",
          })
        ).structuredContent.error.code,
      ).toBe("not_found");
      expect(
        (await tool("list_conversations", { account_id: "qq-main" }))
          .structuredContent.error.code,
      ).toBe("not_found");
      await browser(
        "--allowed-domains",
        "127.0.0.1",
        "open",
        f.config.settings.origin,
      );
      if (process.env.POST_BROWSER_WIDTH)
        await browser(
          "set",
          "viewport",
          process.env.POST_BROWSER_WIDTH,
          process.env.POST_BROWSER_HEIGHT ?? "900",
        );
      await browser("fill", "#password", "owned-fixture-password");
      await click("登录");
      await wait("!!document.querySelector('.bindings')");
      await click("＋ 绑定账号");
      await click("qq-main qq · qq-app 已连接");
      await click("下一步");
      await click("读取可用聊天 / 重试");
      await wait("document.querySelectorAll('.chat-label').length>=3");
      const anonymous = f.app.store.db
        .prepare("SELECT id,seq FROM conversations WHERE native=?")
        .get("label-unknown")!;
      const groupName = "Owned QQ group";
      const fallback = `QQ 私聊 ${anonymous.seq}`;
      await browser("fill", "#search", "label-");
      const labels = await evaluate(
        "Array.from(document.querySelectorAll('label.chat-label')).map(e=>e.innerText)",
      );
      expect
        .soft(labels.find((s: string) => s.includes("label-group")))
        .toContain("群聊");
      expect
        .soft(labels.find((s: string) => s.includes("label-group")))
        .toContain(groupName);
      expect
        .soft(labels.find((s: string) => s.includes("label-peer")))
        .toContain("私聊");
      expect
        .soft(labels.find((s: string) => s.includes("label-peer")))
        .toContain("Owned QQ peer");
      expect
        .soft(labels.find((s: string) => s.includes("label-unknown")))
        .toContain(fallback);
      await shot("qq-candidates");
      for (const native of ["label-group", "label-peer", "label-unknown"]) {
        const row = f.app.store.db
          .prepare("SELECT id FROM conversations WHERE native=?")
          .get(native)!;
        const selector = "#candidate-" + row.id;
        await browser("scrollintoview", selector);
        await browser("click", selector);
      }
      expect(
        await evaluate("document.querySelector('.editor-body').innerText"),
      ).toContain("Owned QQ peer");
      await browser(
        "fill",
        "#chat-name-" + anonymous.id,
        "Owned unnamed contact",
      );
      await browser("scrollintoview", "#chat-name-" + anonymous.id);
      await shot("qq-selected");
      // Explicit selection + final Save grants only this observed QQ contact.
      expect(
        await evaluate("document.querySelectorAll('[id^=peers-]').length"),
      ).toBe(0);
      await click("下一步");
      await click("下一步");
      const review = await evaluate(
        "document.querySelector('[role=dialog] dd').innerText",
      );
      expect(review).toContain(groupName);
      expect(review).toContain("私聊");
      expect(review).toContain("Owned unnamed contact");
      await shot("qq-review");
      await click("保存并应用");
      await wait("!document.querySelector('[role=dialog]')");
      await browser("reload");
      await wait("!!document.querySelector('.binding-details')");
      await evaluate(
        "Array.from(document.querySelectorAll('.binding-details')).at(-1).open=true",
      );
      const detail = await evaluate(
        "Array.from(document.querySelectorAll('.binding-details')).at(-1).innerText",
      );
      expect(detail).toContain(groupName);
      expect(detail).toContain("Owned QQ peer");
      expect(detail).toContain("群聊");
      expect(detail).toContain("私聊");
      expect(detail).toContain("Owned unnamed contact");
      await shot("qq-saved-details");
      const after = await f.app.view();
      expect(
        after.bindings[1]!.scopes.find((s) => s.native_id === "label-peer")!
          .senders,
      ).toEqual(["label-peer"]);
      for (const [native, type, name] of [
        ["label-group", "group", groupName],
        ["label-peer", "direct", "Owned QQ peer"],
        ["label-unknown", "direct", "Owned unnamed contact"],
      ] as const) {
        const scope = after.bindings[1]!.scopes.find(
          (s) => s.native_id === native,
        )!;
        const result = await tool("get_conversation", {
          account_id: "qq-main",
          conversation_name: name,
        });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent.type).toBe(type);
        expect(result.structuredContent.name).toBe(name);
      }
      const listing = await tool("list_conversations", {
        account_id: "qq-main",
      });
      expect(
        listing.structuredContent.items.map((c: any) => ({
          native: c.native_id,
          type: c.type,
          name: c.name,
        })),
      ).toEqual(
        expect.arrayContaining([
          { native: "label-group", type: "group", name: groupName },
          { native: "label-peer", type: "direct", name: "Owned QQ peer" },
          {
            native: "label-unknown",
            type: "direct",
            name: "Owned unnamed contact",
          },
        ]),
      );
      expect(f.receiver.attempts).toEqual([]);
      expect(f.platform.sendCount).toBe(0);
      f.platform.sendQQ("C2C_MESSAGE_CREATE", "later nickname", {
        group_id: undefined,
        group_openid: undefined,
        author: { id: "label-unknown", username: "Later platform name" },
      });
      await until(
        () =>
          f.app.store.db
            .prepare("SELECT count(*) n FROM messages WHERE conversation=?")
            .get(anonymous.id)!.n === 2,
      );
      expect(
        (await f.app.view()).bindings[1]!.scopes.find(
          (s) => s.conversation_id === anonymous.id,
        )!.name,
      ).toBe("Owned unnamed contact");
    } finally {
      await browser("close").catch(() => {});
      await f.close();
    }
  },
);
