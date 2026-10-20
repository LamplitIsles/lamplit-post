<script>
  import { onMount } from "svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  let logged = $state(false),
    loading = $state(true),
    busy = $state(false),
    password = $state(""),
    csrf = "";
  let state = $state({
      accounts: [],
      agents: [],
      bindings: [],
      version: "",
      state: "",
    }),
    agent = $state(""),
    notice = $state(""),
    error = $state("");
  let applying = $state(false);
  let draftSavedVersion = $state("");
  let verifying = $state(false),
    verified = $state(false),
    verificationKey = $state("");
  let verifyController,
    verificationGeneration = 0;
  let qqDraft = $state(null),
    qqBusy = $state(false),
    manualQQ = $state(false);
  let qqController,
    qqGeneration = 0;
  const draftKey = () =>
    JSON.stringify([
      selected?.id,
      selected?.platform,
      selected?.native_id,
      selected?.homeserver,
      platformSecret,
    ]);
  $effect(() => {
    const key = draftKey();
    if (verificationKey && verificationKey !== key) {
      invalidateVerification();
      if (draft && selected)
        draft.scopes = draft.scopes.filter((s) => s.account_id !== selected.id);
    }
    if (selected?.platform !== "qq" && qqDraft) void clearQQ();
    if (!logged) {
      pollController?.abort();
      applying = false;
    }
  });
  const missing = $derived.by(() => {
    if (!draft) return [];
    const reasons = [];
    if (!selected) reasons.push("请选择或新建 IM 账号");
    else {
      if (!selected.native_id)
        reasons.push(
          selected.platform === "matrix"
            ? "填写 Matrix 用户 ID"
            : "先扫码授权，或在高级选项中填写 App ID",
        );
      if (selected.platform === "matrix") {
        if (!selected.homeserver) reasons.push("填写 Homeserver 地址");
        if (newAccount && !platformSecret) reasons.push("填写 Access token");
        if ((newAccount || platformSecret) && !verified)
          reasons.push("验证账号并读取房间");
      } else if (
        newAccount &&
        !platformSecret &&
        qqDraft?.state !== "authorized"
      )
        reasons.push("完成 QQ 扫码授权，或填写 AppSecret");
    }
    return reasons;
  });
  let pollController;
  let open = $state(false),
    draft = $state(null),
    selected = $state(null),
    step = $state(0),
    newAccount = $state(false),
    platformSecret = $state(""),
    aliases = $state("");
  let candidates = $state([]),
    search = $state(""),
    discovery = $state(""),
    directoryState = $state("idle"),
    manual = $state(""),
    direct = $state(false),
    peers = $state("");
  let register = $state(false),
    registration = $state({ id: "", name: "", receiver_url: "" }),
    registrationSecret = $state("");
  let accountRemoval = $state(null);
  let removal = $state(null),
    qr = $state(null),
    share = $state(""),
    shareAccount = $state(null),
    oneTime = $state("");
  const agents = $derived([
    ...new Map(state.agents.map((a) => [a.id, a.name || a.id])).entries(),
  ]);
  const consumer = $derived(state.agents.find((a) => a.id === agent));
  let connection = $state(null),
    connectionSecret = $state("");
  const bindings = $derived(state.bindings.filter((b) => b.agent_id === agent));
  const ownedAccounts = $derived(
    state.accounts.filter((a) =>
      bindings.some((b) => b.account_ids.includes(a.id)),
    ),
  );
  const copy = (o) => JSON.parse(JSON.stringify(o));
  function chatType(chat) {
    if (chat.type === "direct") return "私聊";
    return (state.accounts.find((a) => a.id === chat.account_id)?.platform ||
      selected?.platform) === "qq"
      ? "群聊"
      : "群聊 / 房间";
  }
  function chatName(chat) {
    const platform = state.accounts.find((a) => a.id === chat.account_id)?.platform ||
      selected?.platform;
    if (chat.name?.trim() && (platform !== "qq" || chat.name !== chat.native_id))
      return chat.name;
    return platform === "qq" ? `${chatType(chat)}（名称不可用）` : chat.native_id;
  }
  const qqDirect = (s) =>
    s.type === "direct" &&
    (state.accounts.find((a) => a.id === s.account_id)?.platform ||
      selected?.platform) === "qq";
  const scopeAuthorized = (s) =>
    s.type === "group" ||
    (qqDirect(s) ? s.senders.includes(s.native_id) : s.senders.length > 0);
  const observedContact = (c) =>
    selected?.platform === "qq" && c.type === "direct" &&
    (c.source === "observed" || c.source === "platform");
  const knownContact = (s) =>
    candidates.some((c) => observedContact(c) &&
      c.conversation_id === s.conversation_id && c.native_id === s.native_id);
  const scopeLabel = (s) =>
    `${chatName(s)}（${chatType(s)}${scopeAuthorized(s) ? "" : " · 未授权"}）`;
  const cleanAccount = (a) => {
    const { hasCredential, ready, ...rest } = a;
    if (rest.name === "") delete rest.name;
    return rest;
  };
  const cleanBinding = (b) => {
    const { hasCredential, hasToken, ...rest } = b;
    if (rest.scopes)
      rest.scopes = rest.scopes.map(({ name, ...scope }) => scope);
    return rest;
  };
  const wake = () => ({
    direct: false,
    mention: true,
    reply: true,
    aliases: [],
  });
  const uid = (prefix) =>
    prefix + "_" + crypto.randomUUID().replaceAll("-", "").slice(0, 20);
  const wakeText = (w) =>
    [
      w.direct ? "私聊消息" : "",
      w.mention ? "原生 @ 提及" : "",
      w.reply ? "回复账号消息" : "",
      w.aliases.length ? "文本别名 " + w.aliases.join("、") : "",
    ]
      .filter(Boolean)
      .join("、") || "不自动唤醒";
  const explain = (code, path) =>
    code === "conflict"
      ? path === "matrix/verify"
        ? "账号身份不匹配，或已使用的身份不能更换。请检查用户 ID 和凭据。"
        : "设置已被修改或身份已固定。请刷新后重试；已使用的账号和聊天 ID 不能更换。"
      : code === "unavailable"
        ? "连接暂时不可用。请检查账号凭据和地址后重试。"
        : code === "unauthorized"
          ? path === "login"
            ? "登录未成功，请检查密码或稍后重试。"
            : "登录已过期，请重新登录。"
          : path === "matrix/verify"
            ? "验证未成功，请检查用户 ID、Homeserver 和 Access token 后重试。"
            : "内容未通过检查，请核对 ID、地址和必填项后重试。";
  async function api(path, input, options = {}) {
    const response = await fetch("/api/" + path, {
      ...options,
      method: input === undefined ? "GET" : "POST",
      headers:
        input === undefined
          ? {}
          : { "Content-Type": "application/json", "X-Post-CSRF": csrf },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    }).catch((e) => {
      if (options.signal?.aborted) throw e;
      throw new Error("连接中断。请先重新读取设置，确认是否已保存，再重试。");
    });
    if (response.status === 401 && path !== "login") logged = false;
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(
        `响应不完整（HTTP ${response.status}）。请重新读取设置，确认是否已保存；不要重复提交。`,
      );
    }
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error(
        `响应不完整（HTTP ${response.status}）。请重新读取设置，确认是否已保存；不要重复提交。`,
      );
    if (!response.ok) {
      if (data.busy)
        throw new Error(
          "连接仍在处理，请等待状态更新后重试。此次未接受新设置。",
        );
      if (response.status === 401 && path !== "login") logged = false;
      throw new Error(explain(data.error, path));
    }
    return data;
  }
  async function run(work) {
    if (busy) return;
    busy = true;
    error = "";
    try {
      await work();
    } catch (e) {
      error = e.message || "连接中断，请重试。";
    } finally {
      busy = false;
    }
  }
  async function refresh() {
    state = await api("settings");
    applying = state.busy;
    if (applying && !pollController) void followApply();
    if (!agents.some(([id]) => id === agent)) agent = state.agents[0]?.id || "";
  }
  async function login() {
    await run(async () => {
      const result = await api("login", { password });
      password = "";
      csrf = result.csrf;
      logged = true;
      await refresh();
    });
  }
  async function followApply() {
    const controller = new AbortController();
    pollController = controller;
    try {
      while (logged && !controller.signal.aborted) {
        const status = await api("status", undefined, {
          signal: controller.signal,
        });
        state = { ...state, ...status };
        applying = status.busy;
        if (!status.busy) {
          await refresh();
          await finishDraft(status);
          notice = status.applied
            ? "设置已生效"
            : status.state === "failed_recovered"
              ? "新设置未生效，已恢复原设置。"
              : "连接未就绪，请检查账号后重试。";
          break;
        }
        notice =
          status.state === "failed_draining"
            ? "连接停止超时，正在清理。请勿重复提交。"
            : status.state === "recovering"
              ? "连接未成功，正在恢复原设置…"
              : !status.saved
                ? "尚未保存，正在停止旧连接…"
                : "已保存，正在连接…";
        await new Promise((resolve) => {
          const t = setTimeout(done, 250);
          function done() {
            clearTimeout(t);
            controller.signal.removeEventListener("abort", done);
            resolve();
          }
          controller.signal.addEventListener("abort", done, { once: true });
        });
      }
    } catch (e) {
      if (!controller.signal.aborted) error = e.message;
    } finally {
      if (pollController === controller) pollController = null;
    }
  }
  onMount(() => {
    void (async () => {
      try {
        const s = await api("session");
        csrf = s.csrf;
        logged = true;
        await refresh();
      } catch (e) {
        if (logged) error = e.message || "无法读取设置，请重试。";
      } finally {
        loading = false;
      }
    })();
    return () => {
      pollController?.abort();
      invalidateVerification();
      void clearQQ();
    };
  });
  async function finishDraft(status) {
    if (!draftSavedVersion) return;
    if (status.accepted_version === draftSavedVersion && status.applied) {
      if (qqDraft) qqDraft = { ...qqDraft, state: "committed" };
      dismiss();
    } else {
      draftSavedVersion = "";
      if (qqDraft?.id) {
        const failedDraft = draft,
          authorization = qqDraft;
        let current;
        try {
          current = await api(
            "connect/qq?id=" + encodeURIComponent(authorization.id),
          );
        } catch {
          current = null;
        }
        if (draft !== failedDraft || qqDraft !== authorization) return;
        qqDraft = current;
      }
      invalidateVerification();
      step = 0;
      error =
        "连接未成功，新设置未生效。已保留账号和聊天草稿，请检查连接后重试。";
    }
  }
  async function save(
    accounts,
    bindings,
    secrets = [],
    authorization,
    consumers = state.agents,
  ) {
    let result;
    try {
      result = await api("settings", {
        version: state.version,
        accounts: accounts.map(cleanAccount),
        agents: consumers.map(cleanBinding),
        bindings: bindings.map(cleanBinding),
        conversation_names: bindings.flatMap((b) =>
          b.scopes
            .filter((s) => s.name)
            .map((s) => ({
              account_id: s.account_id,
              conversation_id: s.conversation_id,
              name: s.name,
            })),
        ),
        secrets,
        ...(authorization ? { qq_authorization: authorization } : {}),
      });
    } catch (e) {
      try {
        await refresh();
      } catch {}
      throw e;
    }
    await refresh();
    if (!result.saved)
      throw new Error("尚未保存：旧连接仍在停止或恢复。请等待状态更新后再试。");
    notice = state.applied
      ? "设置已生效"
      : state.busy
        ? "已保存，正在连接…"
        : state.state === "failed_recovered"
          ? "新设置未生效，已恢复原设置。"
          : "连接未就绪，请检查账号后重试。";
    return result;
  }
  function begin(binding) {
    draftSavedVersion = "";
    invalidateVerification();
    void clearQQ();
    manualQQ = false;
    draft = binding
      ? copy(binding)
      : {
          id: uid("binding"),
          agent_id: agent,
          account_ids: [],
          enabled: true,
          scopes: [],
          wake: wake(),
        };
    selected = binding?.account_ids.length
      ? copy(
          cleanAccount(
            state.accounts.find((a) => a.id === binding.account_ids[0]),
          ),
        )
      : null;
    step = 0;
    newAccount = false;
    platformSecret = "";
    aliases = draft.wake.aliases.join(", ");
    candidates = [];
    directoryState = "idle";
    discovery = "";
    search = "";
    open = true;
  }
  function choose(a) {
    invalidateVerification();
    void clearQQ();
    if (selected?.id !== a.id) {
      platformSecret = "";
    }
    selected = copy(cleanAccount(a));
    newAccount = false;
    candidates = [];
    directoryState = "idle";
    discovery = "";
  }
  function addAccount() {
    invalidateVerification();
    void clearQQ();
    manualQQ = false;
    selected = {
      id: uid("account"),
      name: "",
      platform: "qq",
      native_id: "",
      credential: uid("platform"),
    };
    newAccount = true;
    platformSecret = "";
  }
  function invalidateVerification() {
    verificationGeneration++;
    verifyController?.abort();
    verifyController = null;
    verifying = false;
    verified = false;
    verificationKey = "";
    candidates = [];
    directoryState = "idle";
    discovery = "";
  }
  function normalizeDraftId(id, items = []) {
    const previous = selected.id;
    selected = { ...selected, id };
    draft.scopes = draft.scopes.map((scope) => {
      if (scope.account_id !== previous) return scope;
      const pin = items.find(
        (item) =>
          item.native_id === scope.native_id && item.type === scope.type,
      );
      return {
        ...scope,
        account_id: id,
        ...(pin
          ? {
              conversation_id: pin.conversation_id,
              name:
                typeof pin.name === "string" && pin.name.trim()
                  ? pin.name.trim().slice(0, 256)
                  : selected.platform === "qq" ? undefined : scope.native_id,
            }
          : {}),
      };
    });
  }
  async function verifyDraft() {
    invalidateVerification();
    const generation = verificationGeneration,
      controller = new AbortController();
    verifyController = controller;
    verificationKey = draftKey();
    verifying = true;
    error = "";
    try {
      const result = await api(
        "matrix/verify",
        {
          account: cleanAccount(selected),
          ...(platformSecret ? { credential: platformSecret } : {}),
        },
        { signal: controller.signal },
      );
      if (generation !== verificationGeneration || controller.signal.aborted)
        return;
      normalizeDraftId(result.account.id, result.items);
      verificationKey = draftKey();
      candidates = result.items;
      verified = true;
      discovery = candidates.length
        ? "账号已验证。请选择房间；加密房间暂不支持。"
        : "账号已验证，目前没有已加入的房间。";
    } catch (e) {
      if (!controller.signal.aborted) error = e.message;
    } finally {
      if (generation === verificationGeneration) verifying = false;
    }
  }
  async function clearQQ() {
    qqGeneration++;
    qqController?.abort();
    qqController = null;
    const previous = qqDraft;
    qqDraft = null;
    qqBusy = false;
    if (previous?.id && previous.state !== "committed") {
      try {
        await api("connect/qq", { action: "cancel", id: previous.id });
      } catch {}
    }
  }
  async function scanQQ() {
    await clearQQ();
    const generation = qqGeneration,
      controller = new AbortController();
    qqController = controller;
    qqBusy = true;
    manualQQ = false;
    platformSecret = "";
    error = "";
    try {
      const started = await api("connect/qq", {
        action: "start",
        account_id: selected.id,
      });
      if (generation !== qqGeneration || controller.signal.aborted) {
        await api("connect/qq", { action: "cancel", id: started.id });
        return;
      }
      qqDraft = started;
      while (!controller.signal.aborted && generation === qqGeneration) {
        const result = await api(
          "connect/qq?id=" + encodeURIComponent(started.id),
          undefined,
          { signal: controller.signal },
        );
        if (generation !== qqGeneration || controller.signal.aborted) return;
        qqDraft = result;
        if (result.state === "authorized") {
          selected.native_id = result.native_id;
          const local = await api(
            "discover",
            { account_id: result.account_id, qq_authorization: result.id },
            { signal: controller.signal },
          );
          if (generation !== qqGeneration || controller.signal.aborted) return;
          normalizeDraftId(result.account_id, local.items);
          candidates = local.items;
          break;
        }
        if (result.state === "conflict")
          throw new Error(explain("conflict", "connect/qq"));
        if (["expired", "failed", "cancelled"].includes(result.state)) break;
        await new Promise((resolve) => {
          const timer = setTimeout(done, 250);
          function done() {
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", done);
            resolve();
          }
          controller.signal.addEventListener("abort", done, { once: true });
        });
      }
    } catch (e) {
      if (!controller.signal.aborted) error = e.message;
    } finally {
      if (generation === qqGeneration) qqBusy = false;
    }
  }
  async function discover() {
    if (selected.platform === "matrix") return verifyDraft();
    await run(async () => {
      directoryState = "loading";
      let result;
      try {
        result = await api("discover", {
          account_id: selected.id,
          ...(qqDraft?.state === "authorized"
            ? { qq_authorization: qqDraft.id }
            : {}),
        });
      } catch (e) {
        directoryState = "failed";
        throw e;
      }
      candidates = result.items;
      normalizeDraftId(selected.id, candidates);
      directoryState = candidates.length ? "ready" : "empty";
      discovery = "QQ 仅显示本机已观测或手动配置的聊天，不是完整目录。";
    });
  }
  function toggle(c, checked) {
    const scope = {
      ...(c.name?.trim() ? { name: c.name.trim().slice(0, 256) } : {}),
      account_id: selected.id,
      conversation_id: c.conversation_id || uid("chat"),
      native_id: c.native_id,
      type: c.type,
      senders: observedContact(c) ? [c.native_id] : [],
    };
    draft.scopes = checked
      ? [...draft.scopes, scope]
      : draft.scopes.filter(
          (s) =>
            !(
              s.account_id === selected.id &&
              s.native_id === c.native_id &&
              s.type === c.type
            ),
        );
  }
  function manualAdd() {
    if (!manual.trim()) return;
    const existing = [
      ...state.bindings.flatMap((b) => b.scopes),
      ...candidates.map((c) => ({
        account_id: selected.id,
        conversation_id: c.conversation_id,
        native_id: c.native_id,
        type: c.type,
        senders: [],
      })),
    ].find(
      (s) =>
        s.account_id === selected.id &&
        s.native_id === manual.trim() &&
        s.type === (direct ? "direct" : "group"),
    );
    const c = existing
      ? copy(existing)
      : {
          account_id: selected.id,
          conversation_id: uid("chat"),
          native_id: manual.trim(),
          type: direct ? "direct" : "group",
          senders: direct
            ? peers
                .split(/[,，\n]/)
                .map((s) => s.trim())
                .filter(Boolean)
            : [],
        };
    if (!draft.scopes.some((s) => s.conversation_id === c.conversation_id))
      draft.scopes = [...draft.scopes, c];
    manual = "";
    peers = "";
  }
  async function next() {
    if (step < 3) {
      step++;
      return;
    }
    await run(async () => {
      draft.wake.aliases = aliases
        .split(/[,，\n]/)
        .map((x) => x.trim())
        .filter(Boolean);
      const accounts = state.accounts.some((a) => a.id === selected.id)
        ? state.accounts.map((a) => (a.id === selected.id ? selected : a))
        : [...state.accounts, selected];
      draft.account_ids = [...new Set([...draft.account_ids, selected.id])];
      const updated = state.bindings.some((b) => b.id === draft.id)
        ? state.bindings.map((b) => (b.id === draft.id ? draft : b))
        : [...state.bindings, draft];
      const secrets = [];
      if (platformSecret)
        secrets.push({
          ref: selected.credential,
          account: selected.id,
          kind: "platform",
          value: platformSecret,
        });
      const result = await save(
        accounts,
        updated,
        secrets,
        qqDraft?.state === "authorized"
          ? { id: qqDraft.id, account_id: selected.id }
          : undefined,
      );
      draftSavedVersion = result.accepted_version;
      if (!state.busy) await finishDraft(state);
    });
  }
  function dismiss() {
    draftSavedVersion = "";
    invalidateVerification();
    void clearQQ();
    open = false;
    platformSecret = "";
    draft = null;
  }
  async function registerAgent() {
    await run(async () => {
      const c = { ...registration, receiver_credential: uid("receiver") };
      await save(
        state.accounts,
        state.bindings,
        [
          {
            ref: c.receiver_credential,
            account: c.id,
            kind: "receiver",
            value: registrationSecret,
          },
        ],
        undefined,
        [...state.agents, c],
      );
      agent = c.id;
      oneTime = "";
      register = false;
      registrationSecret = "";
      registration = { id: "", name: "", receiver_url: "" };
    });
  }
  async function token(action) {
    await run(async () => {
      const result = await api("token", { agent_id: agent, action });
      oneTime = result.token || "";
      notice =
        action === "issue"
          ? "新令牌只显示这一次，请妥善交给此 agent 的消费者。"
          : "Agent 令牌已撤销";
      await refresh();
    });
  }
  async function showQR(a) {
    shareAccount = a;
    share = a.share_url || "";
    qr = { image: "", url: "" };
  }
  async function makeQR() {
    await run(async () => {
      qr = await api("qr", { url: share });
    });
  }
</script>

{#if loading}<main class="login"><p role="status">正在读取设置…</p></main>
{:else if !logged}
  <main class="login">
    <img src="/brand/post.svg" width="40" height="40" alt="Post" />
    <h1>登录 Post</h1>
    <p>管理 agent 的聊天连接与授权。</p>
    <form
      onsubmit={(e) => {
        e.preventDefault();
        login();
      }}
    >
      <label for="password">管理员密码</label><Input
        id="password"
        type="password"
        autocomplete="current-password"
        bind:value={password}
        required
      /><Button type="submit" disabled={busy}>登录</Button>
    </form>
    <small>由管理员在本机离线设置密码。</small>{#if error}<p role="alert">
        {error}
      </p>{/if}
  </main>
{:else}
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <img src="/brand/post.svg" alt="" width="32" height="32" />Post
      </div>
      <p class="nav-label">Agent 连接</p>
      <nav aria-label="选择 agent">
        {#each agents as [id, name]}<button
            class="agent"
            class:active={agent === id}
            aria-pressed={agent === id}
            onclick={() => {
              agent = id;
              oneTime = "";
            }}
            ><span class="avatar">{name[0]}</span><span
              ><strong>{name}</strong></span
            ></button
          >{/each}
      </nav>
      <Button
        variant="outline"
        onclick={() => {
          register = true;
        }}>＋ 注册 agent</Button
      >
      <p class="sidebar-note">各 agent 使用独立的账号，可连接多个 IM 账号。</p>
    </aside>
    <main>
      <div class="topline">
        <span>设置 / Agent 连接</span>
        <div class="actions">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onclick={() => run(refresh)}>刷新</Button
          ><Button
            variant="ghost"
            size="sm"
            onclick={() =>
              run(async () => {
                await api("logout", {});
                logged = false;
                oneTime = "";
              })}>退出登录</Button
          >
        </div>
      </div>
      {#if error}<div class="notice" role="alert">
          {error}<Button
            variant="outline"
            disabled={busy}
            onclick={() => run(refresh)}>重新读取</Button
          >
        </div>{/if}
      {#if notice}<div class="notice" role="status">{notice}</div>{/if}
      {#if error && !state.version}<section class="empty">
          <h1>暂时无法读取连接</h1>
          <p>请重新读取设置，或检查本机配置。</p>
        </section>
      {:else if !agent}<section class="empty">
          <h1>连接你的第一个 agent</h1>
          <p>
            Post 尚未注册消费者。填写现有 agent 的连接信息，再为它授权聊天。
          </p>
          <Button
            onclick={() => {
              register = true;
            }}>注册 agent</Button
          >
        </section>
      {:else}
        <div class="heading">
          <div>
            <h1>{agents.find(([id]) => id === agent)?.[1]} 的连接</h1>
            <p>选择可以参与的聊天，以及何时被唤醒。</p>
          </div>
          <Button
            id="bind"
            disabled={busy || applying}
            onclick={() => begin(bindings.find((b) => !b.scopes.length))}
            >＋ 绑定账号</Button
          >
        </div>
        {#if !consumer?.hasToken}<p class="callout">
            尚未签发 Agent token。请在下方消费者连接设置中完成连接。
          </p>{/if}
        <section class="bindings" aria-label="已绑定账号">
          <div class="section-head">
            <h2>聊天连接</h2>
            <small
              >{state.state === "applied"
                ? "设置已生效"
                : state.state === "failed_recovered"
                  ? "已恢复原设置"
                  : "服务未就绪"}</small
            >
          </div>
          {#each bindings.filter((b) => b.account_ids.length) as b (b.id)}<article
              class="binding"
            >
              <div class="binding-heading">
                <div class="identity identity-list">
                  {#each b.account_ids as accountId}{@const a =
                      state.accounts.find((a) => a.id === accountId)}
                    <div class="account-identity">
                      <img
                        src={"/brand/platforms/" + a.platform + ".svg"}
                        alt={a.platform}
                        width="30"
                        height="30"
                      />
                      <div>
                        <h3>{a.name || a.id}</h3>
                        <small>{a.ready ? "已连接" : "连接不可用"}</small>
                      </div>
                      <Badge variant="secondary"
                        >{b.enabled
                          ? consumer?.hasToken
                            ? b.scopes.some((s) => s.account_id === accountId && scopeAuthorized(s))
                              ? "已授权聊天"
                              : "未授权聊天"
                            : "待连接消费者"
                          : "已暂停"}</Badge
                      >
                    </div>{/each}
                </div>
              </div>
              <details class="binding-details">
                <summary>详情与编辑</summary>
                <dl>
                  <dt>聊天范围</dt>
                  <dd>
                    {b.scopes.map(scopeLabel).join("、")}
                  </dd>
                  <dt>会唤醒</dt>
                  <dd>{wakeText(b.wake)}</dd>
                  <dt>平台标识</dt>
                  <dd>
                    {b.account_ids
                      .map(
                        (id) =>
                          state.accounts.find((a) => a.id === id)?.native_id,
                      )
                      .join("、")}
                  </dd>
                  <dt>聊天标识</dt>
                  <dd>{b.scopes.map((s) => s.native_id).join("、") || "无"}</dd>
                </dl>
                <div class="actions">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || applying}
                    onclick={() => begin(b)}>编辑绑定</Button
                  ><Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || applying}
                    onclick={() =>
                      run(() =>
                        save(
                          state.accounts,
                          state.bindings.map((x) =>
                            x.id === b.id ? { ...x, enabled: !x.enabled } : x,
                          ),
                        ),
                      )}>{b.enabled ? "暂停绑定" : "恢复绑定"}</Button
                  ><Button
                    variant="ghost"
                    size="sm"
                    onclick={() => {
                      removal = b;
                    }}>撤销聊天授权</Button
                  >{#each state.accounts.filter((a) => a.platform === "qq" && b.account_ids.includes(a.id)) as a}<Button
                      variant="ghost"
                      size="sm"
                      onclick={() => showQR(a)}>添加机器人</Button
                    >{/each}
                  {#each ownedAccounts.filter( (a) => b.account_ids.includes(a.id) ) as a}<Button
                      variant="ghost"
                      size="sm"
                      onclick={() => {
                        accountRemoval = a;
                      }}>删除账号 {a.name || a.id}</Button
                    >{/each}
                </div>
              </details>
            </article>
          {:else}<div class="empty">
              <h2>还没有授权聊天</h2>
              <p>添加此 agent 的账号，然后选择聊天范围。</p>
              <Button variant="outline" onclick={() => begin(bindings[0])}
                >绑定第一个账号</Button
              >
            </div>{/each}
          <div class="footnote">
            Post 可记录收到的消息，只有授权聊天会向此 agent 开放。
          </div>
        </section>
        <details class="guide">
          <summary>消费者连接设置</summary>
          <p>Agent ID：{agent}</p>
          <p>Post 地址：{state.machine_url || "机器 API 尚未就绪"}</p>
          <p>消费者接收地址：{consumer?.receiver_url}</p>
          <small
            >Agent token 访问 Post；接收密钥验证 Post
            的投递。它们与平台凭据相互独立。</small
          >
          <div class="actions">
            <Button
              variant="outline"
              disabled={busy || applying}
              onclick={() => {
                connection = copy(cleanBinding(consumer));
                connectionSecret = "";
              }}>编辑消费者连接</Button
            >
            <Button
              variant="outline"
              disabled={busy || applying}
              onclick={() => token("issue")}>签发 / 替换 Agent token</Button
            ><Button
              variant="ghost"
              disabled={busy || applying}
              onclick={() => token("revoke")}>撤销 token</Button
            >
          </div>
          {#if oneTime}<label for="once">一次性令牌</label><Input
              id="once"
              readonly
              value={oneTime}
            /><Button
              variant="ghost"
              onclick={() => {
                oneTime = "";
              }}>隐藏令牌</Button
            >{/if}
        </details>
      {/if}
    </main>
  </div>
{/if}

<Dialog.Root
  bind:open
  onOpenChange={(value) => {
    if (!value) {
      draftSavedVersion = "";
      invalidateVerification();
      void clearQQ();
      platformSecret = "";
    }
  }}
  ><Dialog.Content class="binding-dialog" showCloseButton={false}
    ><Dialog.Header
      ><Dialog.Title
        >{["选择 IM 账号", "选择聊天范围", "设置唤醒方式", "确认绑定"][
          step
        ]}</Dialog.Title
      ><Dialog.Description
        >{draftSavedVersion
          ? "设置已保存，正在连接。关闭不会撤销此次保存。"
          : `为 ${agent} 设置 · 取消不会修改已保存规则`}</Dialog.Description
      ></Dialog.Header
    >
    <ol class="stepper" aria-label="绑定步骤">
      {#each ["账号", "聊天范围", "唤醒", "确认"] as title, i}<li
          class:current={step === i}
          aria-current={step === i ? "step" : undefined}
        >
          {i + 1}
          {title}
        </li>{/each}
    </ol>
    {#if draft}<div class="editor-body">
        {#if step === 0}<p class="hint">
            此 agent 独立使用账号。保存账号后，再为它授权聊天。
          </p>
          {#each ownedAccounts as a}<button
              class="account-choice"
              class:selected={selected?.id === a.id}
              onclick={() => choose(a)}
              ><span
                ><strong>{a.name || a.id}</strong><small
                  >{a.platform} · {a.native_id}</small
                ></span
              ><Badge variant="outline">{a.ready ? "已连接" : "不可用"}</Badge
              ></button
            >{/each}<Button variant="outline" onclick={addAccount}
            >＋ 新建账号</Button
          >
          {#if selected}<div class="field">
              <label for="account-name">账号名称</label><Input
                id="account-name"
                bind:value={selected.name}
              />
            </div>
            {#if newAccount}<div class="field">
                <label for="platform">平台</label><select
                  id="platform"
                  bind:value={selected.platform}
                  onchange={() => {
                    selected.native_id = "";
                    delete selected.homeserver;
                    platformSecret = "";
                    invalidateVerification();
                    void clearQQ();
                  }}
                  ><option value="qq">QQ 官方机器人</option><option
                    value="matrix">Matrix</option
                  ></select
                >
              </div>
              {#if selected.platform === "qq"}
                <section class="connect-panel" aria-label="QQ 扫码授权">
                  <p>
                    使用手机 QQ 扫码授权机器人。凭据只在 Post
                    保存；聊天授权将在最后确认。
                  </p>
                  {#if qqDraft?.image}<img
                      class="qr"
                      src={qqDraft.image}
                      width="280"
                      height="280"
                      alt="QQ 账号授权二维码"
                    />{/if}
                  <p role="status">
                    {qqDraft?.state === "authorized"
                      ? `已授权机器人 ${qqDraft.native_id}，尚未保存连接`
                      : qqDraft?.state === "expired"
                        ? "授权已过期，请重新扫码。"
                        : qqDraft?.state === "failed"
                          ? "授权未成功，请重试。"
                          : qqBusy
                            ? "等待扫码授权…"
                            : "扫码后获取机器人连接信息。"}
                  </p>
                  <div class="actions">
                    <Button
                      type="button"
                      disabled={qqBusy || busy || applying}
                      onclick={scanQQ}
                      >{qqDraft ? "重新扫码" : "扫码连接 QQ"}</Button
                    >
                    {#if qqBusy}<Button
                        variant="outline"
                        onclick={() => clearQQ()}>取消扫码</Button
                      >{/if}
                  </div>
                  <Button
                    variant="ghost"
                    onclick={() => {
                      void clearQQ();
                      manualQQ = !manualQQ;
                    }}>手动输入 App ID / AppSecret（高级）</Button
                  >
                </section>
              {/if}
              {#if selected.platform === "matrix" || manualQQ}
                <div class="field">
                  <label for="native"
                    >{selected.platform === "qq"
                      ? "App ID"
                      : "Matrix 用户 ID"}</label
                  ><Input id="native" bind:value={selected.native_id} />
                </div>
                {#if selected.platform === "matrix"}<div class="field">
                    <label for="homeserver">Homeserver 地址</label><Input
                      id="homeserver"
                      type="url"
                      bind:value={selected.homeserver}
                    />
                  </div>{/if}{/if}{:else}<small
                >已使用的账号身份不能修改。凭据替换会重新连接此账号。</small
              >{/if}
            {#if selected.platform === "matrix" || !newAccount || manualQQ}<div
                class="field"
              >
                <label for="credential"
                  >{selected.platform === "qq"
                    ? "AppSecret"
                    : "Access token"}{newAccount
                    ? ""
                    : "（留空保留现有凭据）"}</label
                ><Input
                  id="credential"
                  type="password"
                  autocomplete="new-password"
                  bind:value={platformSecret}
                />
              </div>{/if}
            {#if selected.platform === "matrix"}<div class="connect-panel">
                <Button
                  type="button"
                  disabled={verifying ||
                    busy ||
                    applying ||
                    !selected.native_id ||
                    !selected.homeserver ||
                    (newAccount && !platformSecret)}
                  onclick={verifyDraft}
                  >{verifying ? "正在验证…" : "验证并读取房间"}</Button
                >
                <p role="status">
                  {verified
                    ? discovery
                    : verifying
                      ? "正在检查账号和房间…"
                      : "先验证账号，再选择可访问的房间。"}
                </p>
              </div>{/if}
          {/if}
        {:else if step === 1}<p class="hint">
            决定该 agent 可以读取和发送消息的位置；聊天范围不是执行会话。
          </p>
          <div class="actions">
            <Button
              variant="outline"
              disabled={busy ||
                verifying ||
                (newAccount &&
                  selected.platform === "qq" &&
                  qqDraft?.state !== "authorized")}
              onclick={discover}>读取可用聊天 / 重试</Button
            >
          </div>
          <small
            >{newAccount && selected.platform === "qq"
              ? "请先保存账号连接，再从群内 @ 机器人以发现聊天。当前授权草稿尚不能接收消息。"
              : discovery ||
                "候选来自平台返回、本机已观测或手动配置，不会自动授权。"}</small
          >
          {#if selected.platform === "qq"}<p class="hint">
              这里搜索本机已观测 / 已配置的聊天，不是 QQ
              群完整目录。先保存并连接机器人，将它添加到群后在群里 @
              它，再读取聊天并明确选择授权。群标识是此 App 的
              openid，不是公开群号。
            </p>
            {#if directoryState === "empty"}<p role="status">
                本机尚无候选聊天。保存连接后，按上述步骤发现聊天；收到消息不会自动授权或唤醒。
              </p>
            {:else if directoryState === "failed"}<p role="status">
                读取候选失败，尚不能确认本机列表。请检查账号连接后重试。
              </p>
            {:else if directoryState === "idle"}<p role="status">
                点击读取可用聊天，查看本机已有候选。
              </p>{/if}
          {/if}
          <div class="field">
            <label for="search">搜索聊天</label><Input
              id="search"
              bind:value={search}
            />
          </div>
          {#each candidates.filter((c) => ((c.name || "") + " " + c.native_id)
              .toLowerCase()
              .includes(search.toLowerCase())) as c}<div class="chat-row">
              <Checkbox
                id={"candidate-" + c.conversation_id}
                disabled={c.encrypted}
                checked={draft.scopes.some(
                  (s) =>
                    s.account_id === selected.id &&
                    s.native_id === c.native_id &&
                    s.type === c.type,
                )}
                onCheckedChange={(checked) => toggle(c, checked)}
              /><label class="chat-label" for={"candidate-" + c.conversation_id}
                ><span
                  >{chatName(c)}<small
                    >{c.native_id} · {chatType(c)} · {c.source === "platform"
                      ? "平台返回"
                      : c.source === "observed"
                        ? "已观测"
                        : "手动配置"}{c.encrypted
                      ? " · 加密，暂不支持"
                      : ""}</small
                  ></span
                ></label
              >
            </div>{/each}
          <h3>已选聊天</h3>
          {#each draft.scopes.filter((s) => s.account_id === selected.id) as s}<div
              class="chat-row"
            >
              <span class="chat-label"
                >{chatName(s)}<small
                  >{s.native_id} · {chatType(s)}</small
                ></span
              ><Button
                variant="ghost"
                size="sm"
                onclick={() => {
                  draft.scopes = draft.scopes.filter((x) => x !== s);
                }}>移除</Button
              >{#if qqDirect(s)}<div class="field">
                  <p class="hint">{scopeAuthorized(s)
                    ? "保存后仅授权此私聊，其他私聊未授权。"
                    : "未授权此私聊，收到消息不会向此 agent 开放。"}</p>
                  {#if !scopeAuthorized(s)}
                    {#if knownContact(s)}<Button variant="outline" size="sm"
                        onclick={() => { s.senders = [s.native_id]; }}
                        >授权此私聊</Button>
                    {:else}<small>读取可用聊天，确认已观测私聊后再授权。</small>{/if}
                  {/if}
                </div>
              {:else if s.type === "direct"}<div class="field">
                  <label for={"peers-" + s.conversation_id}
                    >允许的私聊成员 ID（逗号分隔）</label
                  ><Input
                    id={"peers-" + s.conversation_id}
                    value={s.senders.join(",")}
                    oninput={(e) => {
                      s.senders = e.currentTarget.value
                        .split(/[,，]/)
                        .map((x) => x.trim())
                        .filter(Boolean);
                    }}
                  />
                </div>{/if}
            </div>{/each}
          <details>
            <summary>手动添加原生 ID</summary><small
              >QQ ID 仅在此 App
              范围有效。手动填写不代表已经验证或接入完整聊天目录。</small
            >
            <div class="field">
              <label for="manual">群聊、私聊或房间原生 ID</label><Input
                id="manual"
                bind:value={manual}
              />
            </div>
            <label class="rule" for="direct"
              >私聊<Switch id="direct" bind:checked={direct} /></label
            >{#if direct}<div class="field">
                <label for="peers"
                  >允许的私聊成员 ID（QQ 为此人的 openid）</label
                ><Input id="peers" bind:value={peers} />
              </div>{/if}<Button variant="outline" onclick={manualAdd}
              >添加到草稿</Button
            >
          </details>
        {:else if step === 2}<p class="hint">
            聊天授权与唤醒分开设置。未命中唤醒规则的已接纳消息仍可作为上下文。
          </p>
          {#each [["direct", "私聊消息"], ["mention", "原生 @ 提及"], ["reply", "回复账号消息"]] as [key, title]}<label
              class="rule"
              for={"wake-" + key}
              >{title}<Switch
                id={"wake-" + key}
                bind:checked={draft.wake[key]}
              /></label
            >{/each}
          <div class="field">
            <label for="aliases">文本别名（逗号分隔）</label><Input
              id="aliases"
              bind:value={aliases}
            /><small>文本别名不是平台原生提及。</small>
          </div>
        {:else}<h3>{selected.name || selected.id}</h3>
          <p>{selected.platform} · {selected.native_id}</p>
          <dl>
            <dt>授权聊天</dt>
            <dd>
              {draft.scopes.map(scopeLabel).join("、") ||
                "无授权聊天"}
              <small>{draft.scopes.map((s) => s.native_id).join("、")}</small>
            </dd>
            <dt>唤醒</dt>
            <dd>
              {wakeText({
                ...draft.wake,
                aliases: aliases.split(/[,，]/).filter(Boolean),
              })}
            </dd>
            <dt>生效方式</dt>
            <dd>先保存，再显示连接结果。连接失败时尝试恢复原设置。</dd>
          </dl>
          <p class="callout">
            账号仅供此 agent 使用。未选聊天不会获得访问权。
          </p>{/if}
        {#if error}<p role="alert">{error}</p>{/if}
      </div>
      {#if missing.length}<p id="next-reason" class="hint" role="status">
          还需：{missing.join("；")}。
        </p>{/if}
      <Dialog.Footer class="editor-footer"
        ><Button variant="ghost" disabled={busy || applying} onclick={dismiss}
          >取消</Button
        >
        <div class="actions">
          {#if step > 0}<Button
              variant="outline"
              disabled={busy || applying}
              onclick={() => {
                step--;
              }}>上一步</Button
            >{/if}<Button
            id="next"
            aria-describedby="next-reason"
            disabled={busy || applying || verifying || missing.length > 0}
            onclick={next}
            >{draftSavedVersion
              ? "已保存，正在连接…"
              : busy
                ? "正在保存…"
                : step === 3
                  ? "保存并应用"
                  : "下一步"}</Button
          >
        </div></Dialog.Footer
      >{/if}</Dialog.Content
  ></Dialog.Root
>

<Dialog.Root
  bind:open={register}
  onOpenChange={(v) => {
    if (!v) registrationSecret = "";
  }}
  ><Dialog.Content class="connection-dialog"
    ><Dialog.Header
      ><Dialog.Title>注册 agent 消费者</Dialog.Title><Dialog.Description
        >填写现有消费者的信息。注册后默认没有聊天访问权。</Dialog.Description
      ></Dialog.Header
    >
    <form
      onsubmit={(e) => {
        e.preventDefault();
        registerAgent();
      }}
    >
      <div class="field">
        <label for="agent-id">Agent ID</label><Input
          id="agent-id"
          pattern={"[a-zA-Z0-9_-]{1,64}"}
          bind:value={registration.id}
          required
        />
      </div>
      <div class="field">
        <label for="agent-name">显示名称</label><Input
          id="agent-name"
          bind:value={registration.name}
          required
        />
      </div>
      <div class="field">
        <label for="register-receiver">消费者接收地址</label><Input
          id="register-receiver"
          type="url"
          bind:value={registration.receiver_url}
          required
        />
      </div>
      <div class="field">
        <label for="register-secret">接收密钥</label><Input
          id="register-secret"
          type="password"
          bind:value={registrationSecret}
          required
        />
      </div>
      {#if error}<p role="alert">{error}</p>{/if}
      <div class="actions">
        <Button
          variant="ghost"
          onclick={() => {
            register = false;
            registrationSecret = "";
          }}>取消</Button
        ><Button type="submit" disabled={busy || applying}
          >{busy ? "正在保存…" : "保存 agent"}</Button
        >
      </div>
    </form></Dialog.Content
  ></Dialog.Root
>

<Dialog.Root
  open={logged && !!removal && removal.agent_id === agent}
  onOpenChange={(v) => {
    if (!v) removal = null;
  }}
  ><Dialog.Content
    ><Dialog.Header
      ><Dialog.Title>撤销聊天授权？</Dialog.Title><Dialog.Description
        >保留此 agent 的账号与历史。可以重新选择聊天。</Dialog.Description
      ></Dialog.Header
    ><Dialog.Footer
      ><Button
        variant="outline"
        disabled={busy || applying}
        onclick={() => {
          removal = null;
        }}>取消</Button
      ><Button
        disabled={busy || applying}
        onclick={() =>
          run(async () => {
            await save(
              state.accounts,
              state.bindings.map((b) =>
                b.id === removal.id ? { ...b, scopes: [] } : b,
              ),
            );
            removal = null;
          })}>确认撤销</Button
      ></Dialog.Footer
    ></Dialog.Content
  ></Dialog.Root
>

<Dialog.Root
  open={logged &&
    !!accountRemoval &&
    ownedAccounts.some((a) => a.id === accountRemoval.id)}
  onOpenChange={(v) => {
    if (!v) accountRemoval = null;
  }}
  ><Dialog.Content
    ><Dialog.Header
      ><Dialog.Title
        >删除账号 {accountRemoval?.name || accountRemoval?.id}？</Dialog.Title
      >
      <Dialog.Description
        >移除此账号的连接、凭据和聊天授权，保留历史。不会删除平台账号。</Dialog.Description
      ></Dialog.Header
    ><Dialog.Footer
      ><Button
        variant="outline"
        disabled={busy || applying}
        onclick={() => {
          accountRemoval = null;
        }}>取消</Button
      ><Button
        disabled={busy || applying}
        onclick={() =>
          run(async () => {
            const id = accountRemoval.id;
            await save(
              state.accounts.filter((a) => a.id !== id),
              state.bindings.map((b) => ({
                ...b,
                account_ids: b.account_ids.filter((account) => account !== id),
                scopes: b.scopes.filter((s) => s.account_id !== id),
              })),
            );
            accountRemoval = null;
          })}>确认删除账号</Button
      ></Dialog.Footer
    ></Dialog.Content
  ></Dialog.Root
>

<Dialog.Root
  open={!!qr}
  onOpenChange={(v) => {
    if (!v) {
      qr = null;
      shareAccount = null;
    }
  }}
  ><Dialog.Content
    ><Dialog.Header
      ><Dialog.Title>添加 / 打开 QQ 机器人</Dialog.Title><Dialog.Description
        >使用官方机器人资料卡的分享链接。此处不是个人 QQ 登录。</Dialog.Description
      ></Dialog.Header
    >
    <p>
      尚未核实可自动取得资料卡的公共 API。请从 QQ
      官方平台取得此机器人的分享链接。
    </p>
    <label for="share">官方分享链接（HTTPS QQ 域名）</label><Input
      id="share"
      type="url"
      bind:value={share}
    /><Button disabled={busy || applying} onclick={makeQR}>生成二维码</Button
    >{#if error}<p role="alert">
        {error}
      </p>{/if}{#if qr?.image}<img
        class="qr"
        src={qr.image}
        alt="QQ 机器人分享链接二维码"
        width="260"
        height="260"
      /><small
        >来源：管理员粘贴的官方分享链接。生成二维码不代表已添加，也不会增加
        agent 授权。</small
      >
      <div class="actions">
        <Button
          variant="outline"
          onclick={() =>
            run(async () => {
              await navigator.clipboard.writeText(qr.url);
              notice = "链接已复制";
            })}>复制链接</Button
        ><Button
          variant="outline"
          href={qr.url}
          target="_blank"
          rel="noopener noreferrer">打开链接</Button
        ><Button
          disabled={busy || applying}
          onclick={() =>
            run(async () => {
              await save(
                state.accounts.map((a) =>
                  a.id === shareAccount.id ? { ...a, share_url: qr.url } : a,
                ),
                state.bindings,
              );
            })}>保存分享链接</Button
        >
      </div>{/if}</Dialog.Content
  ></Dialog.Root
>

<Dialog.Root
  open={!!connection}
  onOpenChange={(v) => {
    if (!v) {
      connection = null;
      connectionSecret = "";
    }
  }}
>
  <Dialog.Content class="connection-dialog">
    <Dialog.Header
      ><Dialog.Title>编辑消费者连接</Dialog.Title><Dialog.Description
        >该 agent 的所有聊天共用此连接。接收密钥留空保留现有值。</Dialog.Description
      ></Dialog.Header
    >
    {#if connection}<form
        onsubmit={(e) => {
          e.preventDefault();
          run(async () => {
            await save(
              state.accounts,
              state.bindings,
              connectionSecret
                ? [
                    {
                      ref: connection.receiver_credential,
                      account: connection.id,
                      kind: "receiver",
                      value: connectionSecret,
                    },
                  ]
                : [],
              undefined,
              state.agents.map((a) =>
                a.id === connection.id ? connection : a,
              ),
            );
            connection = null;
            connectionSecret = "";
          });
        }}
      >
        <div class="field">
          <label for="connection-url">消费者接收地址</label><Input
            id="connection-url"
            type="url"
            required
            bind:value={connection.receiver_url}
          />
        </div>
        <div class="field">
          <label for="connection-secret">接收密钥（留空保留）</label><Input
            id="connection-secret"
            type="password"
            autocomplete="new-password"
            bind:value={connectionSecret}
          />
        </div>
        {#if error}<p role="alert">{error}</p>{/if}
        <div class="actions">
          <Button
            variant="ghost"
            onclick={() => {
              connection = null;
              connectionSecret = "";
            }}>取消</Button
          ><Button type="submit" disabled={busy || applying}>保存连接</Button>
        </div>
      </form>{/if}
  </Dialog.Content>
</Dialog.Root>
