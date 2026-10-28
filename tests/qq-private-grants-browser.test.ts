import { test, expect, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { readFile, mkdir } from "node:fs/promises";
import { settingsFixture } from "./fixtures/settings";
import { until } from "./fixtures/state";

for (const mode of ["new-selection", "old-empty", "old-mismatched"] as const)
  test.skipIf(!process.env.POST_BROWSER_CHECK)(
    `explicit QQ private ${mode} grants only the observed contact on final save; cancel and old rules deny`,
    async () => {
      const lines: string[] = [];
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation((line) => lines.push(String(line)));
      const f = await settingsFixture(
        false,
        1500,
        undefined,
        undefined,
        resolve("dist/web"),
      );
      const env = {
        ...process.env,
        AGENT_BROWSER_SESSION: "peer-" + randomBytes(5).toString("hex"),
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
      const shot = async (label: string) => {
        if (!process.env.POST_PRIVATE_EVIDENCE) return;
        await mkdir(process.env.POST_PRIVATE_EVIDENCE, { recursive: true });
        await browser(
          "screenshot",
          resolve(
            process.env.POST_PRIVATE_EVIDENCE,
            mode + "-" + label + ".png",
          ),
        );
      };
      const peer = "owned-selected-peer";
      let received = 0;
      const native = (id: string, sender = peer) =>
        f.platform.sendQQ("C2C_MESSAGE_CREATE", "owned private body", {
          id,
          group_id: undefined,
          group_openid: undefined,
          author: { id: sender, username: "Owned selected contact" },
        });
      const capture = async (id: string, sender = peer) => {
        native(id, sender);
        received++;
        await until(
          () =>
            f.app.store.db
              .prepare(
                "SELECT count(*) n FROM messages WHERE account='qq-main'",
              )
              .get()!.n === received,
        );
      };
      const apply = async (transform: (bindings: any[]) => any[]) => {
        const v = await f.app.view();
        const hasOther = v.agents.some((a) => a.id === "other-agent");
        const own = v.bindings
          .filter((b) => b.agent_id === "cfl")
          .map((b) => ({ ...b, scopes: b.scopes.map(({ name, ...s }) => s) }));
        const others = v.bindings.filter((b) => b.agent_id !== "cfl");
        expect(
          (
            await f.apply("settings", {
              version: v.version,
              accounts: v.accounts.map(({ hasCredential, ready, ...a }) => a),
              agents: [
                ...v.agents.map(({ hasCredential, hasToken, ...a }) => a),
                ...(!hasOther
                  ? [
                      {
                        id: "other-agent",
                        name: "Other",
                        receiver_url: f.receiver.url,
                        receiver_credential: "other-receiver",
                      },
                    ]
                  : []),
              ],
              secrets: hasOther
                ? []
                : [
                    {
                      ref: "other-receiver",
                      account: "other-agent",
                      kind: "receiver",
                      value: "owned-other-secret",
                    },
                  ],
              bindings: [
                ...transform(own),
                ...(hasOther
                  ? others
                  : [
                      {
                        id: "other-binding",
                        agent_id: "other-agent",
                        account_ids: [],
                        enabled: true,
                        scopes: [],
                        wake: {
                          direct: true,
                          mention: true,
                          reply: false,
                          aliases: [],
                        },
                      },
                    ]),
              ],
            })
          ).status,
        ).toBe(200);
      };
      const openContact = async () => {
        if (mode === "new-selection") await click("＋ 绑定账号");
        else {
          await browser(
            "eval",
            "document.querySelector('.binding-details').open=true",
          );
          await click("编辑绑定");
        }
        await click("qq-main qq · qq-app 已连接");
        await click("保存并连接");
        await wait("document.querySelector('[data-slot=dialog-title]')?.textContent.trim()==='查找聊天'");
        await click("读取可用聊天 / 重试");
        await wait("document.querySelectorAll('label.chat-label').length>=1");
        if (mode === "new-selection")
          await browser(
            "find",
            "nth",
            "0",
            "[role=checkbox]:not([disabled])",
            "click",
          );
        else {
          expect(
            await browser(
              "eval",
              "document.querySelector('.editor-body').textContent",
            ),
          ).toContain("未授权此私聊");
          await browser(
            "eval",
            "Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()==='授权此私聊').scrollIntoView({block:'center'})",
          );
          await shot("denied-before-explicit-action");
          await click("授权此私聊");
        }
      };
      try {
        await f.login();
        await apply((bindings) =>
          bindings.map((b) => ({
            ...b,
            scopes: b.scopes.filter((s: any) => s.account_id !== "qq-main"),
          })),
        );
        await capture("candidate-before-grant");
        const conversation = f.app.store.db
          .prepare(
            "SELECT id FROM conversations WHERE account='qq-main' AND native=?",
          )
          .get(peer)!;
        const originalSenders =
          mode === "old-mismatched" ? ["different-owned-peer"] : [];
        if (mode !== "new-selection")
          await apply((bindings) =>
            bindings.map((b) => ({
              ...b,
              wake: { ...b.wake, direct: true },
              scopes: [
                ...b.scopes,
                {
                  account_id: "qq-main",
                  conversation_id: conversation.id,
                  native_id: peer,
                  type: "direct",
                  senders: originalSenders,
                },
              ],
            })),
          );
        await browser(
          "--allowed-domains",
          "127.0.0.1",
          "open",
          f.config.settings.origin,
        );
        await browser("fill", "#password", "owned-fixture-password");
        await click("登录");
        await wait("!!document.querySelector('.bindings')");
        if (mode !== "new-selection") {
          expect(
            await browser(
              "eval",
              "Array.from(document.querySelectorAll('.account-identity')).find(e=>e.textContent.includes('qq-main')).textContent",
            ),
          ).toContain("未授权聊天");
          await capture("old-rule-still-denied");
          expect(f.receiver.attempts).toHaveLength(0);
        }
        await openContact();
        const before = await readFile(f.path, "utf8");
        const beforeBindings = (await f.app.view()).bindings;
        expect(
          await browser(
            "eval",
            "document.querySelector('.editor-body').textContent",
          ),
        ).toContain("保存后仅授权此私聊");
        await browser(
          "eval",
          "Array.from(document.querySelectorAll('.editor-body .hint')).find(e=>e.textContent.includes('保存后仅授权此私聊')).scrollIntoView({block:'center'})",
        );
        await shot("draft-before-cancel");
        await click("稍后完成");
        await wait("!document.querySelector('[data-slot=dialog-overlay]')");
        expect(await readFile(f.path, "utf8")).toBe(before);
        expect((await f.app.view()).bindings).toEqual(beforeBindings);
        await capture("cancel-still-denied");
        expect(f.receiver.attempts).toHaveLength(0);
        await openContact();
        await click("下一步");
        if (mode === "new-selection") await browser("click", "#wake-direct");
        await click("下一步");
        await click("保存聊天授权");
        await wait("!document.querySelector('[role=dialog]')");
        await browser("reload");
        await wait("!!document.querySelector('.bindings')");
        await shot("saved-reloaded");
        const saved = await f.app.view();
        const binding = saved.bindings.find((b) =>
          b.scopes.some((s) => s.native_id === peer),
        )!;
        const scope = binding.scopes.find((s) => s.native_id === peer)!;
        expect(scope.senders).toEqual([peer]);
        expect(binding.wake.direct).toBe(true);
        await capture("after-ui-save");
        const observation = lines
          .map((l) => JSON.parse(l))
          .filter((r) => r.event === "qq_inbound" && r.stage === "observation")
          .at(-1);
        expect(observation).toMatchObject({
          type: "direct",
          admitted: 1,
          peer_denied: 0,
          wake_direct: 1,
          deliveries_created: 1,
        });
        await until(() => f.receiver.attempts.length === 1);
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
            params: {
              name: "read_messages",
              arguments: {
                account_id: "qq-main",
                conversation_name: scope.name,
              },
            },
          }),
        });
        const result = (await response.json()).result;
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent.items).toHaveLength(received);
        await capture("stranger-still-denied", "unselected-stranger");
        expect(f.receiver.attempts).toHaveLength(1);
        expect(
          (await f.app.view()).bindings[0]!.scopes.filter(
            (s) => s.account_id === "matrix-main",
          ),
        ).toEqual(
          beforeBindings[0]!.scopes.filter(
            (s) => s.account_id === "matrix-main",
          ),
        );
        expect(
          saved.bindings.filter((b) => b.agent_id === "other-agent"),
        ).toEqual(beforeBindings.filter((b) => b.agent_id === "other-agent"));
        expect(f.platform.sendCount).toBe(0);
      } finally {
        await browser("close").catch(() => {});
        await f.close();
        warn.mockRestore();
      }
    },
  );
