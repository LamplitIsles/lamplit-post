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
  let state = $state({ accounts: [], bindings: [], version: "", state: "" }),
    agent = $state(""),
    notice = $state(""),
    error = $state("");
  let open = $state(false),
    draft = $state(null),
    selected = $state(null),
    step = $state(0),
    newAccount = $state(false),
    platformSecret = $state(""),
    receiverSecret = $state(""),
    aliases = $state("");
  let candidates = $state([]),
    search = $state(""),
    discovery = $state(""),
    manual = $state(""),
    direct = $state(false),
    peers = $state("");
  let register = $state(false),
    registration = $state({ agent_id: "", name: "", receiver_url: "" }),
    registrationSecret = $state("");
  let removal = $state(null),
    qr = $state(null),
    share = $state(""),
    shareAccount = $state(null),
    oneTime = $state("");
  const agents = $derived([
    ...new Map(
      state.bindings.map((b) => [b.agent_id, b.name || b.agent_id]),
    ).entries(),
  ]);
  const bindings = $derived(state.bindings.filter((b) => b.agent_id === agent));
  const copy = (o) => JSON.parse(JSON.stringify(o));
  const cleanAccount = (a) => {
    const { hasCredential, ready, ...rest } = a;
    return rest;
  };
  const cleanBinding = (b) => {
    const { hasCredential, hasToken, ...rest } = b;
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
  const explain = (code) =>
    code === "conflict"
      ? "设置已被修改或身份已固定。请刷新后重试；已使用的账号和聊天 ID 不能更换。"
      : code === "unavailable"
        ? "连接暂时不可用。请检查账号凭据和地址后重试。"
        : code === "unauthorized"
          ? "登录已过期，请重新登录。"
          : "内容未通过检查，请核对 ID、地址和必填项后重试。";
  async function api(path, input) {
    const response = await fetch("/api/" + path, {
      method: input === undefined ? "GET" : "POST",
      headers:
        input === undefined
          ? {}
          : { "Content-Type": "application/json", "X-Post-CSRF": csrf },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    }).catch(() => {
      throw new Error("连接中断。请先重新读取设置，确认是否已保存，再重试。");
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401 && path !== "login") logged = false;
      throw new Error(explain(data.error));
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
    if (!agents.some(([id]) => id === agent))
      agent = state.bindings[0]?.agent_id || "";
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
  onMount(async () => {
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
  });
  async function save(accounts, bindings, secrets = []) {
    const result = await api("settings", {
      version: state.version,
      accounts: accounts.map(cleanAccount),
      bindings: bindings.map(cleanBinding),
      secrets,
    });
    await refresh();
    if (!result.applied)
      throw new Error(
        result.state === "failed_recovered"
          ? "新设置未生效，已恢复原设置。请检查连接后重试。"
          : "保存或恢复失败。服务未就绪，请检查配置后重试。",
      );
    notice = "已保存并生效";
  }
  function begin(binding) {
    draft = binding
      ? copy(cleanBinding(binding))
      : {
          id: uid("binding"),
          agent_id: agent,
          name: bindings[0]?.name,
          enabled: true,
          receiver_url: bindings[0]?.receiver_url || "",
          receiver_credential: uid("receiver"),
          scopes: [],
          wake: wake(),
        };
    selected = binding?.scopes.length
      ? copy(
          cleanAccount(
            state.accounts.find((a) => a.id === binding.scopes[0].account_id),
          ),
        )
      : null;
    step = 0;
    newAccount = false;
    platformSecret = "";
    receiverSecret = "";
    aliases = draft.wake.aliases.join(", ");
    candidates = [];
    discovery = "";
    search = "";
    open = true;
  }
  function choose(a) {
    if (selected?.id !== a.id) {
      draft.scopes = [];
      platformSecret = "";
    }
    selected = copy(cleanAccount(a));
    newAccount = false;
    candidates = [];
    discovery = "";
  }
  function addAccount() {
    draft.scopes = [];
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
  async function discover() {
    await run(async () => {
      const result = await api("discover", { account_id: selected.id });
      candidates = result.items;
      discovery =
        result.source === "local"
          ? "QQ 仅显示本机已观测或手动配置的聊天，不是完整目录。"
          : "Matrix 当前加入的房间；加密房间暂不支持。";
    });
  }
  function toggle(c, checked) {
    const scope = {
      account_id: selected.id,
      conversation_id: c.conversation_id || uid("chat"),
      native_id: c.native_id,
      type: c.type,
      senders: [],
    };
    draft.scopes = checked
      ? [...draft.scopes, scope]
      : draft.scopes.filter((s) => s.conversation_id !== c.conversation_id);
  }
  function manualAdd() {
    if (!manual.trim()) return;
    const existing = state.bindings
      .flatMap((b) => b.scopes)
      .find(
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
      if (receiverSecret)
        secrets.push({
          ref: draft.receiver_credential,
          account: draft.id,
          kind: "receiver",
          value: receiverSecret,
        });
      await save(accounts, updated, secrets);
      platformSecret = "";
      receiverSecret = "";
      open = false;
    });
  }
  function dismiss() {
    open = false;
    platformSecret = "";
    receiverSecret = "";
    draft = null;
  }
  async function registerAgent() {
    await run(async () => {
      const id = uid("binding");
      const b = {
        id,
        ...registration,
        enabled: true,
        receiver_credential: uid("receiver"),
        scopes: [],
        wake: wake(),
      };
      await save(
        state.accounts,
        [...state.bindings, b],
        registrationSecret
          ? [
              {
                ref: b.receiver_credential,
                account: id,
                kind: "receiver",
                value: registrationSecret,
              },
            ]
          : [],
      );
      agent = b.agent_id;
      oneTime = "";
      register = false;
      registrationSecret = "";
      registration = { agent_id: "", name: "", receiver_url: "" };
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
              ><strong>{name}</strong><small
                >{state.bindings
                  .filter((b) => b.agent_id === id)
                  .reduce((n, b) => n + b.scopes.length, 0)} 个授权聊天</small
              ></span
            ></button
          >{/each}
      </nav>
      <Button
        variant="outline"
        onclick={() => {
          register = true;
        }}>＋ 注册 agent</Button
      >
      <p class="sidebar-note">
        同一账号可以供多个 agent 使用，聊天授权各自独立。
      </p>
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
            disabled={busy}
            onclick={() => begin(bindings.find((b) => !b.scopes.length))}
            >＋ 绑定账号</Button
          >
        </div>
        {#if bindings.some((b) => !b.hasToken)}<p class="callout">
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
          {#each bindings.filter((b) => b.scopes.length) as b (b.id)}<article
              class="binding"
            >
              <div class="binding-heading">
                <div class="identity identity-list">
                  {#each [...new Set(b.scopes.map((s) => s.account_id))] as accountId}{@const a =
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
                        <small
                          >{a.native_id} · {a.ready
                            ? "已连接"
                            : "连接不可用"}</small
                        >
                      </div>
                    </div>{/each}
                </div>
                <Badge variant="secondary"
                  >{b.enabled
                    ? b.hasToken
                      ? "已启用"
                      : "待连接消费者"
                    : "已暂停"}</Badge
                >
              </div>
              <dl>
                <dt>聊天范围</dt>
                <dd>
                  {b.scopes
                    .map(
                      (s) =>
                        s.native_id +
                        "（" +
                        (s.type === "direct" ? "私聊" : "群聊 / 房间") +
                        "）",
                    )
                    .join("、")}
                </dd>
                <dt>会唤醒</dt>
                <dd>{wakeText(b.wake)}</dd>
                <dt>账号共享</dt>
                <dd>
                  {state.bindings.some(
                    (x) =>
                      x.agent_id !== agent &&
                      x.scopes.some((s) =>
                        b.scopes.some((t) => s.account_id === t.account_id),
                      ),
                  )
                    ? "其他 agent 也在使用，授权各自独立"
                    : "目前仅此 agent 使用"}
                </dd>
              </dl>
              <div class="actions">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onclick={() => begin(b)}>编辑绑定</Button
                ><Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
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
                  }}>解绑</Button
                >{#each state.accounts.filter((a) => a.platform === "qq" && b.scopes.some((s) => s.account_id === a.id)) as a}<Button
                    variant="ghost"
                    size="sm"
                    onclick={() => showQR(a)}>添加机器人</Button
                  >{/each}
              </div>
            </article>
          {:else}<div class="empty">
              <h2>还没有授权聊天</h2>
              <p>绑定已有账号或添加新账号，然后选择聊天范围。</p>
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
          <p>消费者接收地址：{bindings[0]?.receiver_url}</p>
          <small
            >Agent token 访问 Post；接收密钥验证 Post
            的投递。它们与平台凭据相互独立。</small
          >
          <div class="actions">
            <Button
              variant="outline"
              disabled={busy}
              onclick={() => token("issue")}>签发 / 替换 Agent token</Button
            ><Button
              variant="ghost"
              disabled={busy}
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
      platformSecret = "";
      receiverSecret = "";
    }
  }}
  ><Dialog.Content class="binding-dialog" showCloseButton={false}
    ><Dialog.Header
      ><Dialog.Title
        >{["选择 IM 账号", "选择聊天范围", "设置唤醒方式", "确认绑定"][
          step
        ]}</Dialog.Title
      ><Dialog.Description
        >为 {agent} 设置 · 取消不会修改已保存规则</Dialog.Description
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
            共享账号不会复制其他 agent 的聊天授权。
          </p>
          {#each state.accounts as a}<button
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
                  ><option value="qq">QQ 官方机器人</option><option
                    value="matrix">Matrix</option
                  ></select
                >
              </div>
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
                </div>{/if}{:else}<small
                >已使用的账号身份不能修改。凭据替换会重新连接共享此账号的绑定。</small
              >{/if}
            <div class="field">
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
          <details>
            <summary>此绑定的消费者连接</summary>
            <div class="field">
              <label for="receiver">接收地址</label><Input
                id="receiver"
                type="url"
                bind:value={draft.receiver_url}
              />
            </div>
            <div class="field">
              <label for="receiver-secret">接收密钥（留空保留）</label><Input
                id="receiver-secret"
                type="password"
                autocomplete="new-password"
                bind:value={receiverSecret}
              />
            </div>
          </details>
        {:else if step === 1}<p class="hint">
            决定该 agent 可以读取和发送消息的位置；聊天范围不是执行会话。
          </p>
          <div class="actions">
            <Button
              variant="outline"
              disabled={busy || newAccount}
              onclick={discover}>读取可用聊天 / 重试</Button
            >
          </div>
          <small
            >{newAccount
              ? "新账号保存并连接后才能读取平台房间；现在可以手动填写原生 ID。"
              : discovery ||
                "候选来自平台返回、本机已观测或手动配置，不会自动授权。"}</small
          >
          <div class="field">
            <label for="search">搜索聊天</label><Input
              id="search"
              bind:value={search}
            />
          </div>
          {#each candidates.filter((c) => (c.name + " " + c.native_id)
              .toLowerCase()
              .includes(search.toLowerCase())) as c}<div class="chat-row">
              <Checkbox
                id={"candidate-" + c.conversation_id}
                disabled={c.encrypted}
                checked={draft.scopes.some(
                  (s) => s.conversation_id === c.conversation_id,
                )}
                onCheckedChange={(checked) => toggle(c, checked)}
              /><label class="chat-label" for={"candidate-" + c.conversation_id}
                ><span
                  >{c.name}<small
                    >{c.native_id} · {c.source === "platform"
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
          {#each draft.scopes as s}<div class="chat-row">
              <span class="chat-label"
                >{s.native_id}<small
                  >{s.type === "direct" ? "私聊" : "群聊 / 房间"}</small
                ></span
              ><Button
                variant="ghost"
                size="sm"
                onclick={() => {
                  draft.scopes = draft.scopes.filter((x) => x !== s);
                }}>移除</Button
              >{#if s.type === "direct"}<div class="field">
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
              {draft.scopes.map((s) => s.native_id).join("、") || "无授权聊天"}
            </dd>
            <dt>唤醒</dt>
            <dd>
              {wakeText({
                ...draft.wake,
                aliases: aliases.split(/[,，]/).filter(Boolean),
              })}
            </dd>
            <dt>生效方式</dt>
            <dd>保存后等待连接重新就绪。失败时尝试恢复原设置。</dd>
          </dl>
          <p class="callout">
            共享账号的其他 agent 保留各自授权。绑定不会授予未选聊天的访问权。
          </p>{/if}
        {#if error}<p role="alert">{error}</p>{/if}
      </div>
      <Dialog.Footer class="editor-footer"
        ><Button variant="ghost" disabled={busy} onclick={dismiss}>取消</Button>
        <div class="actions">
          {#if step > 0}<Button
              variant="outline"
              disabled={busy}
              onclick={() => {
                step--;
              }}>上一步</Button
            >{/if}<Button
            id="next"
            disabled={busy ||
              !selected ||
              !selected.native_id ||
              !draft.receiver_url ||
              (newAccount && !platformSecret)}
            onclick={next}
            >{busy ? "正在应用…" : step === 3 ? "保存并应用" : "下一步"}</Button
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
  ><Dialog.Content
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
          pattern="[a-zA-Z0-9_-]{(1, 64)}"
          bind:value={registration.agent_id}
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
        ><Button type="submit" disabled={busy}>保存 agent</Button>
      </div>
    </form></Dialog.Content
  ></Dialog.Root
>

<Dialog.Root
  open={!!removal}
  onOpenChange={(v) => {
    if (!v) removal = null;
  }}
  ><Dialog.Content
    ><Dialog.Header
      ><Dialog.Title>解绑此连接？</Dialog.Title><Dialog.Description
        >撤销此 agent 的聊天授权，不删除历史。其他 agent 的授权保持独立。</Dialog.Description
      ></Dialog.Header
    ><Dialog.Footer
      ><Button
        variant="outline"
        disabled={busy}
        onclick={() => {
          removal = null;
        }}>取消</Button
      ><Button
        disabled={busy}
        onclick={() =>
          run(async () => {
            await save(
              state.accounts,
              state.bindings
                .filter((b) => b.id !== removal.id || bindings.length === 1)
                .map((b) => (b.id === removal.id ? { ...b, scopes: [] } : b)),
            );
            removal = null;
          })}>确认解绑</Button
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
    /><Button disabled={busy} onclick={makeQR}>生成二维码</Button>{#if error}<p
        role="alert"
      >
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
          disabled={busy}
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
