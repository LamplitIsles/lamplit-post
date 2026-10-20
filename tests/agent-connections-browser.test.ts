import { test, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { settingsFixture } from "./fixtures/settings";
import { until } from "./fixtures/state";

test.skipIf(!process.env.POST_BROWSER_CHECK)(
  "browser one consumer, Matrix then QQ association, zero-grant discovery, readable persisted labels and compact details",
  async () => {
    const f = await settingsFixture(
      true,
      1500,
      undefined,
      undefined,
      resolve("dist/web"),
    );
    const env = {
      ...process.env,
      AGENT_BROWSER_SESSION:
        "post-connection-" + randomBytes(6).toString("hex"),
    };
    const exec = promisify(execFile);
    async function browser(args: string[]) {
      return (
        await exec("agent-browser", args, { env, timeout: 10000 })
      ).stdout.trim();
    }
    async function evaluate(code: string): Promise<any> {
      let value: any = await browser(["eval", code]);
      for (let i = 0; i < 3 && typeof value === "string"; i++) {
        try {
          value = JSON.parse(value);
        } catch {
          break;
        }
      }
      return value;
    }
    const wait = (code: string) =>
      browser(["wait", "--fn", code, "--timeout", "4000"]);
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
    const evidence = process.env.POST_CONNECTION_EVIDENCE;
    async function shot(name: string) {
      await evaluate(
        "Promise.all([document.fonts.ready,...document.getAnimations().filter(a=>a.playState==='running').map(a=>a.finished.catch(()=>{}))])",
      );
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        await browser(["screenshot", resolve(evidence, name + ".png")]);
      }
    }
    async function bounds() {
      expect(
        await evaluate("document.documentElement.scrollWidth <= innerWidth"),
      ).toBe(true);
      expect(
        await evaluate(
          "(()=>{const d=document.querySelector('[role=dialog]');if(!d)return true;const r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1})()",
        ),
      ).toBe(true);
    }
    try {
      await browser([
        "--allowed-domains",
        "127.0.0.1",
        "open",
        f.config.settings.origin,
      ]);
      await browser(["set", "viewport", "1280", "633"]);
      await fill("password", "owned-fixture-password");
      await click("登录");
      await click("＋ 注册 agent");
      await fill("agent-id", "browser-agent");
      await fill("agent-name", "Owned agent");
      await fill("register-receiver", f.receiver.url);
      await fill("register-secret", "test-receiver");
      await click("保存 agent");
      await wait("!document.querySelector('[role=dialog]')");
      await browser(["click", ".guide > summary"]);
      await click("签发 / 替换 Agent token");
      await click("绑定第一个账号");
      await wait("!!document.querySelector('[role=dialog]')");
      await click("＋ 新建账号");
      await browser(["select", "#platform", "matrix"]);
      await fill("account-name", "Matrix account");
      await fill("native", "@post:fixture");
      await fill("homeserver", f.platform.url);
      await fill("credential", "test-matrix-platform-secret");
      expect(
        await evaluate(
          "!document.querySelector('#receiver-secret') && !document.querySelector('#receiver')",
        ),
      ).toBe(true);
      await click("验证并读取房间");
      await wait("document.body.textContent.includes('账号已验证')");
      await click("下一步");
      const candidate = await evaluate(
        "document.querySelector('.chat-label')?.textContent",
      );
      expect(candidate).toContain("Owned fixture room");
      await browser([
        "find",
        "nth",
        "0",
        "[role=checkbox]:not([disabled])",
        "click",
      ]);
      expect(
        await evaluate(
          "document.querySelector('.editor-body').textContent.includes('Owned fixture room')",
        ),
      ).toBe(true);
      await click("下一步");
      await click("下一步");
      expect(
        await evaluate(
          "document.querySelector('dd').textContent.includes('Owned fixture room')",
        ),
      ).toBe(true);
      await click("保存并应用");
      await wait("!document.querySelector('[role=dialog]')");
      await click("＋ 绑定账号");
      await click("＋ 新建账号");
      await fill("account-name", "QQ account");
      await click("手动输入 App ID / AppSecret（高级）");
      await fill("native", "qq-app");
      await fill("credential", "test-qq-platform-secret");
      await click("下一步");
      expect(
        await evaluate(
          "document.querySelector('[role=dialog]').textContent.includes('先保存')",
        ),
      ).toBe(true);
      await click("下一步");
      await click("下一步");
      await click("保存并应用");
      await wait("!document.querySelector('[role=dialog]')");
      await browser(["reload"]);
      await wait("document.querySelectorAll('.binding').length===2");
      const v = await f.app.view();
      expect(v.agents).toHaveLength(1);
      expect(v.bindings).toHaveLength(2);
      expect(v.bindings[1]!.scopes).toHaveLength(0);
      expect(await evaluate("document.querySelector('nav').innerText")).toBe(
        "O\nOwned agent",
      );
      expect(
        await evaluate("document.querySelector('.bindings').innerText"),
      ).toContain("QQ account");
      expect(
        await evaluate("document.querySelector('.bindings').innerText"),
      ).toContain("未授权聊天");
      const matrixBefore = structuredClone(v.bindings[0]);
      await shot("desktop-list");
      await bounds();
      // Open QQ's details and edit only QQ. Refresh local candidates from owned native @.
      await evaluate(
        "document.querySelectorAll('.binding-details')[1].open=true",
      );
      await evaluate(
        "document.querySelectorAll('.binding')[1].querySelector('button').click()",
      );
      await wait("!!document.querySelector('[role=dialog]')");
      await click("下一步");
      await click("读取可用聊天 / 重试");
      await wait(
        "document.querySelector('[role=dialog]').textContent.includes('本机尚无候选聊天')",
      );
      expect(
        await evaluate(
          "document.querySelector('[role=dialog]').textContent.includes('本机尚无候选聊天')",
        ),
      ).toBe(true);
      f.platform.sendQQ("GROUP_AT_MESSAGE_CREATE", "owned discovery", {
        group_id: "owned-new-group",
        group_openid: "owned-new-group",
      });
      await until(
        () =>
          !!f.app.store.db
            .prepare(
              "SELECT id FROM conversations WHERE native='owned-new-group'",
            )
            .get(),
      );
      expect(f.receiver.attempts).toHaveLength(0);
      await click("读取可用聊天 / 重试");
      await wait("!!document.querySelector('.chat-label')");
      await fill("search", "owned-new");
      expect(
        await evaluate("document.querySelector('.chat-label').textContent"),
      ).toContain("已观测");
      await shot("desktop-qq-discovery");
      await bounds();
      await browser(["press", "Escape"]);
      await wait("!document.querySelector('[role=dialog]')");
      expect((await f.app.view()).bindings[0]).toEqual(matrixBefore);
      await evaluate("document.querySelector('.guide').open=true");
      // Standalone editor: focus/Escape and explicit cancel do not mutate anything.
      const before = await readFile(f.path, "utf8");
      await click("编辑消费者连接");
      await wait("!!document.querySelector('#connection-url')");
      expect(
        await evaluate(
          "document.querySelector('[role=dialog]').contains(document.activeElement)",
        ),
      ).toBe(true);
      expect(
        await evaluate("document.querySelector('#connection-secret').value"),
      ).toBe("");
      await fill("connection-url", "http://127.0.0.1:1");
      await browser(["press", "Escape"]);
      await wait("!document.querySelector('[role=dialog]')");
      expect(await readFile(f.path, "utf8")).toBe(before);
      await click("编辑消费者连接");
      await fill("connection-secret", "discard-owned");
      await click("取消");
      await wait("!document.querySelector('[role=dialog]')");
      expect(await readFile(f.path, "utf8")).toBe(before);
      for (const [width, height] of [
        [1280, 633],
        [390, 633],
        [1280, 480],
        [390, 480],
      ]) {
        await browser(["set", "viewport", String(width), String(height)]);
        await evaluate(
          "document.querySelectorAll('.binding-details').forEach(d=>d.open=false);window.scrollTo(0,0)",
        );
        await bounds();
        const collapsed = await evaluate(
          "document.querySelector('.bindings').innerText",
        );
        for (const text of [
          "聊天范围",
          "会唤醒",
          "账号共享",
          "Owned fixture room",
          "!room:fixture",
        ])
          expect(collapsed).not.toContain(text);
        if (height === 633)
          await shot(width === 390 ? "mobile-list" : "desktop-list");
        await browser(["focus", ".binding-details > summary"]);
        await browser(["press", "Enter"]);
        const expanded = await evaluate(
          "document.querySelector('.bindings').innerText",
        );
        expect(expanded).not.toContain("账号共享");
        for (const text of [
          "聊天范围",
          "会唤醒",
          "Owned fixture room",
          "!room:fixture",
        ])
          expect(expanded).toContain(text);
        if (height === 633)
          await shot(width === 390 ? "mobile-details" : "desktop-details");
        await browser(["press", "Enter"]);
        if (width === 390 && height === 633) {
          await evaluate(
            "document.querySelectorAll('.binding')[1].scrollIntoView({block:'center'})",
          );
          await shot("mobile-qq-list");
        }
        await evaluate("document.querySelector('.guide').open=true");
        await click("编辑消费者连接");
        await evaluate(
          "document.querySelectorAll('.binding-details').forEach(d=>d.open=false);window.scrollTo(0,0)",
        );
        await bounds();
        if (height === 633)
          await shot(width === 390 ? "mobile-consumer" : "desktop-consumer");
        await browser(["press", "Escape"]);
        await wait("!document.querySelector('[role=dialog]')");
        await evaluate(
          "document.querySelector('.binding-details').open=true; document.querySelector('.binding').querySelector('button').click()",
        );
        await wait("!!document.querySelector('[role=dialog]')");
        await bounds();
        await click("下一步");
        await bounds();
        expect(
          await evaluate(
            "document.querySelector('.editor-body').textContent.includes('Owned fixture room')",
          ),
        ).toBe(true);
        if (height === 633)
          await shot(
            width === 390 ? "mobile-matrix-label" : "desktop-matrix-label",
          );
        await browser(["press", "Escape"]);
        await wait("!document.querySelector('[role=dialog]')");
      }
      await f.login();
      // One owner has both accounts, with only Matrix chat grants.
      const mixed = await f.app.view();
      const matrixAccount = mixed.accounts.find(
        (a) => a.platform === "matrix",
      )!;
      const qqAccount = mixed.accounts.find((a) => a.platform === "qq")!;
      const binding = mixed.bindings.find((b) =>
        b.account_ids.includes(matrixAccount.id),
      )!;
      binding.account_ids = [matrixAccount.id, qqAccount.id];
      const permissions = binding.scopes.map(({ name, ...scope }) => scope);
      const pins = f.app.store.db
        .prepare("SELECT id,account,native,type FROM conversations ORDER BY id")
        .all();
      expect(
        (
          await f.apply("settings", {
            version: mixed.version,
            agents: mixed.agents.map(({ hasCredential, hasToken, ...a }) => a),
            accounts: mixed.accounts.map(({ hasCredential, ready, ...a }) => a),
            bindings: [{ ...binding, scopes: permissions }],
          })
        ).ok,
      ).toBe(true);
      await browser(["reload"]);
      await wait("document.querySelectorAll('.account-identity').length===2");
      const accountStatus: { name: string; text: string }[] = await evaluate(
        "Array.from(document.querySelectorAll('.account-identity')).map(e=>({name:e.querySelector('h3').textContent,text:e.innerText}))",
      );
      expect
        .soft(accountStatus.find((a) => a.name === "QQ account")?.text)
        .toContain("未授权聊天");
      expect
        .soft(accountStatus.find((a) => a.name === "Matrix account")?.text)
        .toContain("已授权聊天");
      for (const width of [1280, 390]) {
        await browser(["set", "viewport", String(width), "633"]);
        await evaluate("window.scrollTo(0,0)");
        await bounds();
        await shot(
          width === 390 ? "mixed-mobile-status" : "mixed-desktop-status",
        );
      }
      // Explicitly grant the already observed QQ candidate before refreshing Matrix;
      // verification must preserve this other account's independent permission.
      const observed = f.app.store.db
        .prepare("SELECT id FROM conversations WHERE account=? AND native=?")
        .get(qqAccount.id, "owned-new-group")!;
      permissions.push({
        account_id: qqAccount.id,
        conversation_id: String(observed.id),
        native_id: "owned-new-group",
        type: "group",
        senders: [],
      });
      const beforeRefresh = await f.app.view();
      expect(
        (
          await f.apply("settings", {
            version: beforeRefresh.version,
            agents: beforeRefresh.agents.map(
              ({ hasCredential, hasToken, ...a }) => a,
            ),
            accounts: beforeRefresh.accounts.map(
              ({ hasCredential, ready, ...a }) => a,
            ),
            bindings: [{ ...binding, scopes: permissions }],
          })
        ).ok,
      ).toBe(true);
      expect(f.receiver.attempts).toHaveLength(0);
      await browser(["reload"]);
      await wait("document.querySelectorAll('.account-identity').length===2");
      const newName = "<b>显示名称</b>" + "长".repeat(600);
      f.platform.roomName(newName);
      await evaluate(
        "document.querySelector('.binding-details').open=true;document.querySelector('.binding').querySelector('button').click()",
      );
      await wait("!!document.querySelector('[role=dialog]')");
      await click("验证并读取房间");
      await wait(
        "document.querySelector('[role=dialog]').textContent.includes('账号已验证')",
      );
      await click("下一步");
      expect(
        await evaluate(
          "document.querySelector('.chat-label').textContent.includes('<b>显示名称</b>') && !document.querySelector('.chat-label b')",
        ),
      ).toBe(true);
      expect
        .soft(
          await evaluate(
            "document.querySelector('h3 + .chat-row .chat-label').textContent.includes('<b>显示名称</b>')",
          ),
        )
        .toBe(true);
      await bounds();
      await click("下一步");
      await click("下一步");
      expect
        .soft(
          await evaluate(
            "document.querySelector('[role=dialog] dd').textContent.includes('<b>显示名称</b>')",
          ),
        )
        .toBe(true);
      await click("保存并应用");
      await wait("!document.querySelector('[role=dialog]')");
      await browser(["reload"]);
      await wait("document.querySelectorAll('.account-identity').length===2");
      const refreshed = (await f.app.view()).bindings[0]!;
      expect.soft(refreshed.scopes[0]!.name).toBe(newName.slice(0, 256));
      expect(refreshed.scopes.map(({ name, ...scope }) => scope)).toEqual(
        permissions,
      );
      expect(refreshed.account_ids).toEqual([matrixAccount.id, qqAccount.id]);
      expect(
        f.app.store.db
          .prepare(
            "SELECT id,account,native,type FROM conversations ORDER BY id",
          )
          .all(),
      ).toEqual(pins);
    } catch (e) {
      console.info("browser_failure", String(e));
      try {
        console.info(await browser(["console"]));
        console.info(await browser(["errors"]));
      } catch {}
      throw e;
    } finally {
      try {
        await browser(["close"]);
      } catch {}
      await f.close();
    }
  },
  90000,
);
