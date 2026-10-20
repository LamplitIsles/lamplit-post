import { test, expect } from "vitest";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import { stringify, parse } from "smol-toml";
import { platformsFixture } from "./fixtures/platforms";
import { stateFixture } from "./fixtures/state";
import { processFixture } from "./fixtures/process";
import { Store } from "../src/store";

// Explicit real Chromium acceptance; agent-browser is an operator test tool, not a runtime dependency.
test.skipIf(!process.env.POST_BROWSER_CHECK)(
  "browser clears account secrets and one-time tokens when their principal changes",
  async () => {
    const a = await platformsFixture(),
      b = await platformsFixture("@second:fixture");
    const state = await stateFixture(a.url, "http://127.0.0.1:1");
    const listener = createServer();
    await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
    const port = (listener.address() as any).port;
    await new Promise<void>((r) => listener.close(() => r()));
    const config = {
      ...state.config,
      accounts: [
        { ...state.config.accounts[1], name: "Account A" },
        {
          id: "matrix-second",
          name: "Account B",
          platform: "matrix" as const,
          native_id: "@second:fixture",
          credential: "matrix-second-secret",
          homeserver: b.url,
        },
      ],
      bindings: state.config.bindings.map((binding) => ({
        ...binding,
        account_ids: ["matrix-main", "matrix-second"],
        scopes: binding.scopes.filter((s) => s.account_id === "matrix-main"),
      })),
      settings: {
        port,
        origin: `http://127.0.0.1:${port}`,
        admin_file: join(state.dir, "admin.json"),
      },
    };
    const originalB = "owned-B-" + randomBytes(16).toString("hex"),
      replacementA = "owned-A-" + randomBytes(16).toString("hex");
    b.matrixCredential(originalB);
    const correctedA = "owned-repaired-A-" + randomBytes(16).toString("hex");
    a.matrixCredential(correctedA);
    const store = await Store.open(config);
    await store.putSecret(
      "matrix-second-secret",
      "matrix-second",
      "platform",
      originalB,
    );
    await store.close();
    const path = join(state.dir, "post.toml");
    await writeFile(path, stringify(config), { mode: 0o600 });
    const env = {
      ...process.env,
      HOME: state.dir,
      XDG_CONFIG_HOME: state.dir,
      XDG_DATA_HOME: state.dir,
      XDG_STATE_HOME: state.dir,
      NODE_OPTIONS: "",
      npm_config_user_agent: "",
    };
    const run = (cmd: string, input?: string) =>
      processFixture(
        [resolve("dist/node-artifact/dist/cli.cjs"), cmd, "--config", path],
        { cwd: state.dir, env, input },
      );
    const browserEnv = {
      ...process.env,
      AGENT_BROWSER_SESSION:
        "post-principals-" + randomBytes(6).toString("hex"),
    };
    async function browser(args: string[], input?: string) {
      const child = execFile("agent-browser", args, {
        env: browserEnv,
        encoding: "utf8",
        timeout: 10000,
      });
      if (input !== undefined) child.stdin?.end(input);
      return new Promise<string>((resolve, reject) => {
        let output = "";
        child.stdout?.on("data", (chunk) => (output += chunk));
        child.stderr?.resume();
        child.once("error", () =>
          reject(
            new Error(
              "Owned browser action failed: " +
                args[0] +
                (args[0] === "find" ? " " + args.slice(1).join(" ") : ""),
            ),
          ),
        );
        child.once("close", (code) =>
          code === 0
            ? resolve(output.trim())
            : reject(
                new Error(
                  "Owned browser action failed: " +
                    args[0] +
                    (args[0] === "find" ? " " + args.slice(1).join(" ") : ""),
                ),
              ),
        );
      });
    }
    async function evaluate(script: string): Promise<any> {
      let value: any = await browser(["eval", "--stdin"], script);
      for (let n = 0; n < 3 && typeof value === "string"; n++) {
        try {
          value = JSON.parse(value);
        } catch {
          break;
        }
      }
      return value;
    }
    const click = async (name: string) => {
      await evaluate(
        "Promise.all(document.getAnimations().filter(a=>a.playState==='running').map(a=>a.finished.catch(()=>{})))",
      );
      if (name === "编辑绑定")
        await evaluate("document.querySelector('.binding-details').open=true");
      return browser([
        "find",
        "role",
        "button",
        "click",
        "--name",
        name,
        "--exact",
      ]);
    };
    const wait = (script: string) =>
      browser(["wait", "--fn", script, "--timeout", "4000"]);
    let child: ReturnType<typeof run> | undefined;
    try {
      expect(
        (await run("admin-provision", "owned-browser-password").exited).code,
      ).toBe(0);
      child = run("serve");
      const availability = await child.settingsReady();
      expect(availability.ready).toBe(false);
      expect(availability.settings_ready).toBe(true);
      expect(availability.url).toBeNull();
      await browser([
        "--allowed-domains",
        "127.0.0.1",
        "open",
        config.settings.origin,
      ]);
      await browser(["fill", "#password", "owned-browser-password"]);
      await click("登录");
      await wait("!!document.querySelector('.guide')");
      await evaluate(
        `window.__ownedSaves=[];const originalFetch=window.fetch.bind(window);window.fetch=async(...args)=>{const response=await originalFetch(...args);if(String(args[0]).endsWith('/api/settings')&&args[1]?.method==='POST'){const value=await response.clone().json();window.__ownedSaves.push({status:response.status,saved:value.saved,applied:value.applied,state:value.state,error:value.error});}return response};true`,
      );
      // Cold-start native rejection remains repairable through the actual editor.
      expect(
        await evaluate("document.body.textContent.includes('服务未就绪')"),
      ).toBe(true);
      await click("编辑绑定");
      await browser(["fill", "#credential", correctedA]);
      await click("验证并读取房间");
      await wait("document.body.textContent.includes('账号已验证')");
      await click("下一步");
      await click("下一步");
      await click("下一步");
      await click("保存并应用");
      await wait("!document.querySelector('[role=dialog]')");
      await wait("document.body.textContent.includes('设置已生效')");
      expect(
        await evaluate("document.body.textContent.includes('设置已生效')"),
      ).toBe(true);
      // Canonical existing TOML, only the write-only credential changes. Verification
      // succeeds before this owned provider invalidates it for the actual apply.
      const beforeReplacement = await readFile(path, "utf8");
      await click("编辑绑定");
      await browser(["fill", "#credential", replacementA]);
      a.matrixCredential(replacementA);
      await click("验证并读取房间");
      await wait("document.body.textContent.includes('账号已验证')");
      a.matrixCredential(correctedA);
      await click("下一步");
      await click("下一步");
      await click("下一步");
      await click("保存并应用");
      await wait("document.body.textContent.includes('已保留账号和聊天草稿')");
      expect(
        await evaluate(
          "!!document.querySelector('[role=dialog]') && document.querySelector('#credential').value.length > 0",
        ),
      ).toBe(true);
      expect(await readFile(path, "utf8")).toBe(beforeReplacement);
      expect(
        await evaluate(
          "(async()=>{const s=await(await fetch('/api/status')).json();return s.ready && !s.saved && !s.applied && s.state==='failed_recovered' && s.accepted_version===s.active_version})()",
        ),
      ).toBe(true);
      await browser(["press", "Escape"]);
      await wait("!document.querySelector('[role=dialog]')");
      await evaluate("window.__ownedSaves=[];true");
      await click("编辑绑定");
      await browser(["fill", "#credential", replacementA]);
      await browser(["find", "role", "button", "click", "--name", "Account B"]);
      expect(
        await evaluate(
          "document.querySelector('#credential').value.length === 0",
        ),
      ).toBe(true);
      // Same selection preserves a draft; switching to a different identity clears it.
      await browser(["fill", "#credential", replacementA]);
      await browser(["find", "role", "button", "click", "--name", "Account B"]);
      expect(
        await evaluate(
          `document.querySelector('#credential').value === ${JSON.stringify(replacementA)}`,
        ),
      ).toBe(true);
      await browser(["find", "nth", "0", ".account-choice", "click"]);
      expect(
        await evaluate(
          "document.querySelector('#credential').value.length === 0",
        ),
      ).toBe(true);
      await browser(["find", "role", "button", "click", "--name", "Account B"]);
      await click("下一步");
      await click("下一步");
      await click("下一步");
      await click("保存并应用");
      await wait("window.__ownedSaves.length > 0");
      expect(
        await evaluate(
          "window.__ownedSaves[0].saved === true && window.__ownedSaves[0].applied === false",
        ),
      ).toBe(true);
      await wait("!document.querySelector('[role=dialog]')");
      await wait("document.body.textContent.includes('设置已生效')");
      expect(
        b.calls.some(
          (c) =>
            c.path.endsWith("/whoami") && c.auth === "Bearer " + replacementA,
        ),
      ).toBe(false);
      await evaluate(
        "Promise.all(document.getAnimations().filter(a=>a.playState==='running').map(a=>a.finished.catch(()=>{})))",
      );
      if (!(await evaluate("document.querySelector('.guide').open"))) {
        await browser(["focus", ".guide > summary"]);
        await browser(["press", "Enter"]);
      }
      await wait("document.querySelector('.guide').open");
      await click("签发 / 替换 Agent token");
      await wait("!!document.querySelector('#once')");
      await evaluate(
        "window.__ownedTokenA = document.querySelector('#once').value; true",
      );
      await click("＋ 注册 agent");
      await browser(["fill", "#agent-id", "agent-b"]);
      await browser(["fill", "#agent-name", "Agent B"]);
      await browser(["fill", "#register-receiver", "http://127.0.0.1:1"]);
      await browser(["fill", "#register-secret", "owned-browser-receiver"]);
      await click("保存 agent");
      await wait(
        "!document.querySelector('#agent-id') && document.querySelector('.guide')?.textContent.includes('Agent ID：agent-b')",
      );
      expect(
        await evaluate(
          "!!window.__ownedTokenA && !document.querySelector('#once')",
        ),
      ).toBe(true);
      if (process.env.POST_BROWSER_EVIDENCE) {
        await mkdir(dirname(resolve(process.env.POST_BROWSER_EVIDENCE)), {
          recursive: true,
        });
        await browser([
          "screenshot",
          resolve(process.env.POST_BROWSER_EVIDENCE),
        ]);
      }
      if (process.env.POST_BROWSER_EVIDENCE) {
        await browser(["set", "viewport", "390", "844"]);
        expect(
          await evaluate("document.documentElement.scrollWidth <= innerWidth"),
        ).toBe(true);
        await browser([
          "screenshot",
          resolve(
            process.env.POST_BROWSER_EVIDENCE.replace(/\.png$/, "-mobile.png"),
          ),
        ]);
      }
      expect(
        await evaluate(
          "localStorage.length === 0 && sessionStorage.length === 0",
        ),
      ).toBe(true);
      const consoleOutput = await browser(["console"]);
      expect(
        [originalB, replacementA, correctedA].some((secret) =>
          consoleOutput.includes(secret),
        ),
      ).toBe(false);
      await evaluate("delete window.__ownedTokenA; true");
      await browser(["reload"]);
      await wait(
        "document.querySelector('.guide')?.textContent.includes('Agent ID：')",
      );
      expect(await evaluate("!document.querySelector('#once')")).toBe(true);
      await browser(["close"]);
      child.kill("SIGTERM");
      expect((await child.exited).code).toBe(0);
      child = undefined;
      const reopened = await Store.open(config);
      try {
        expect(
          (await reopened.secret(
            "matrix-second-secret",
            "matrix-second",
            "platform",
          )) === originalB,
        ).toBe(true);
        expect(
          (await reopened.secret(
            "matrix-secret",
            "matrix-main",
            "platform",
          )) === correctedA,
        ).toBe(true);
        expect(
          reopened.db
            .prepare("SELECT agent FROM tokens WHERE agent=?")
            .get("agent-b"),
        ).toBeUndefined();
      } finally {
        await reopened.close();
      }
      const persisted = parse(await readFile(path, "utf8")) as any;
      expect(persisted.bindings[0].account_ids).toEqual([
        "matrix-main",
        "matrix-second",
      ]);
      expect(persisted.bindings[0].scopes).toEqual(config.bindings[0]!.scopes);
      expect(persisted.agents.some((a: any) => a.id === "agent-b")).toBe(true);
      expect(JSON.stringify(persisted).includes(replacementA)).toBe(false);
    } finally {
      try {
        await browser(["close"]);
      } catch {}
      child?.kill("SIGKILL");
      if (child) await child.exited;
      await a.close();
      await b.close();
      await state.close();
    }
  },
);
