<script>
  import { onMount } from "svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";

  let { account, enabled, applying, configurationStatus, api, rename, close } = $props();
  const controller = new AbortController();
  const mimeTypes = ["image/png", "image/jpeg", "image/webp"];
  const call = (action, fields = {}) =>
    api(
      "keet/" + action,
      { account_id: account.id, ...fields },
      {
        signal: controller.signal,
      },
    );
  let section = $state("invites");
  let directory = $state(null),
    profile = $state(null);
  let busy = $state(false),
    error = $state(""),
    notice = $state("");
  let working = $derived(busy || applying || !!configurationStatus);
  let link = $state(""),
    preview = $state(null),
    linkAttempts = $state({});
  let unsettled = $state({});
  let displayName = $state(""),
    avatar = $state(null),
    profileUncertain = $state(false);
  let avatarInput = $state(null);
  let renaming = $state(null),
    roomName = $state("");
  let linkOutcome = $derived(
    preview?.room_id ? "joined" : linkAttempts[preview?.target_id],
  );
  let nicknameChanged = $derived(
    displayName.trim() !== (profile?.display_name ?? ""),
  );
  let currentAvatar = $derived(avatar ?? profile?.avatar);
  const inviteKey = (invite) =>
    JSON.stringify([invite.kind, invite.room_id, invite.peer_id]);
  const nativeLink = () =>
    link.trim().replace(/^https:\/\/keet\.io\/chat\/?#/, "keet://chat/");
  const acceptLabel = (kind) =>
    enabled
      ? kind === "group"
        ? "加入并授权"
        : "接受并授权"
      : kind === "group"
        ? "加入房间"
        : "接受私聊";

  async function run(work) {
    if (working) return;
    busy = true;
    error = "";
    try {
      await work();
    } catch (e) {
      if (!controller.signal.aborted)
        error =
          e.code === "conflict"
            ? "当前状态已变更。请重新读取后再操作。"
            : e.code === "unavailable"
              ? "Keet 暂时不可用，请稍后重新读取。"
              : e.message;
    } finally {
      busy = false;
    }
  }
  async function readDirectory() {
    directory = await call("directory");
  }
  function setProfile(value) {
    profile = value;
    displayName = value.display_name ?? "";
    avatar = null;
    profileUncertain = false;
  }
  function readProfile() {
    return run(async () => setProfile(await call("profile")));
  }
  function select(next) {
    section = next;
    notice = "";
    error = "";
    if (next === "profile" && !profile) void readProfile();
    if (next === "rooms" || (next === "invites" && !directory))
      void run(readDirectory);
  }
  onMount(() => {
    void run(readDirectory);
    return () => controller.abort();
  });

  function inspectLink() {
    return run(async () => {
      notice = "";
      const value = nativeLink();
      if (!value.startsWith("keet://chat/"))
        throw new Error("请粘贴 Keet 房间的邀请链接。");
      preview = await call("link/inspect", { link: value });
      if (preview.room_id) await readDirectory();
      else if (linkAttempts[preview.target_id] === "joined")
        delete linkAttempts[preview.target_id];
    });
  }
  function joinLink() {
    return run(async () => {
      notice = "";
      const target = preview.target_id;
      try {
        const result = await call("link/join", {
          link: nativeLink(),
          target_id: target,
        });
        linkAttempts[target] = result.status;
      } catch (e) {
        if (!e.uncertain) throw e;
        linkAttempts[target] = "unknown";
      }
      if (linkOutcome === "joined") await readDirectory();
    });
  }
  function accept(invite) {
    return run(async () => {
      const { kind, room_id, peer_id } = invite;
      let status;
      try {
        status = (await call("invites/accept", { kind, room_id, peer_id }))
          .status;
      } catch (e) {
        if (!e.uncertain) throw e;
        status = "unknown";
      }
      unsettled[inviteKey(invite)] = invite;
      notice =
        status === "joined"
          ? kind === "direct"
            ? "已接受私聊。"
            : "已加入房间。"
          : status === "pending"
            ? "正在加入。请重新读取邀请，确认结果。"
            : "加入结果待确认。请重新读取邀请。";
      if (status === "joined") await readDirectory();
    });
  }
  function chooseAvatar(event) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    return run(async () => {
      if (
        !mimeTypes.includes(file.type) ||
        file.size < 1 ||
        file.size > 8 * 1024 * 1024
      )
        throw new Error("请选择 8 MiB 以内的 PNG、JPEG 或 WebP 图片。");
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("读取图片失败，请重新选择。"));
        reader.readAsDataURL(file);
      });
      avatar = { mime: file.type, data_base64: data.split(",")[1] };
    });
  }
  function saveProfile() {
    return run(async () => {
      notice = "";
      try {
        setProfile(
          await call("profile/save", {
            ...(nicknameChanged ? { display_name: displayName.trim() } : {}),
            ...(avatar ? { avatar } : {}),
          }),
        );
      } catch (e) {
        if (e.uncertain || e.code === "unavailable") {
          profileUncertain = true;
          throw new Error("保存结果待确认。请重新读取 Keet 资料。");
        }
        if (e.code === "invalid_request")
          throw new Error("Keet 未接受资料。请检查昵称，或重新选择有效图片。");
        throw e;
      }
      notice = "Keet 资料已保存。";
    });
  }
  function saveRoomName() {
    return run(async () => {
      const applied = await rename(renaming, roomName.trim());
      renaming = null;
      notice = applied
        ? "聊天名称已保存。"
        : "名称已提交。连接恢复后请重新读取聊天。";
      if (applied) await readDirectory();
    });
  }
</script>

<Dialog.Root
  open={true}
  onOpenChange={(open) => {
    if (!open) close();
  }}
>
  <Dialog.Content class="binding-dialog" showCloseButton={false}>
    <Dialog.Header>
      <Dialog.Title>管理 Keet · {account.name || account.id}</Dialog.Title>
      <Dialog.Description>
        {configurationStatus
          ? "设置状态待确认。请关闭此窗口并刷新设置。"
          : enabled
          ? "加入的房间和接受的私聊会向此 agent 开放。"
          : "绑定已暂停。恢复绑定后，已加入的聊天将向此 agent 开放。"}
      </Dialog.Description>
    </Dialog.Header>
    <div class="actions keet-sections" role="group" aria-label="Keet 管理">
      {#each [["invites", "Keet 邀请"], ["rooms", "已加入的聊天"], ["profile", "Keet 资料"]] as [value, label]}
        <Button
          variant={section === value ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={section === value}
          disabled={working}
          onclick={() => select(value)}>{label}</Button
        >
      {/each}
    </div>

    <div class="editor-body" aria-busy={working}>
      {#if section === "invites"}
        <div class="section-head">
          <h3>待处理邀请</h3>
          <Button
            variant="ghost"
            size="sm"
            disabled={working}
            onclick={() => run(readDirectory)}>重新读取邀请</Button
          >
        </div>
        {#if directory && !directory.invites.length}
          <p class="hint">目前没有待处理的邀请。</p>
        {:else if directory}
          {#each directory.invites as invite (inviteKey(invite))}
            <div class="chat-row keet-row">
              <span
                ><strong
                  >{invite.name ||
                    (invite.kind === "group"
                      ? "未命名房间"
                      : "未知联系人")}</strong
                >
                <small
                  >{invite.kind === "group" ? "房间邀请" : "私聊请求"}</small
                ></span
              >
              <Button
                size="sm"
                variant="outline"
                disabled={working || !!unsettled[inviteKey(invite)]}
                onclick={() => accept(invite)}
                >{unsettled[inviteKey(invite)]
                  ? "待确认"
                  : acceptLabel(invite.kind)}</Button
              >
            </div>
          {/each}
        {/if}
        <form
          class="keet-form"
          onsubmit={(event) => {
            event.preventDefault();
            void inspectLink();
          }}
        >
          <div class="field">
            <label for="keet-link">房间邀请链接</label>
            <Input
              id="keet-link"
              maxlength="8192"
              autocomplete="off"
              spellcheck={false}
              disabled={working}
              bind:value={link}
              oninput={() => {
                preview = null;
              }}
            />
          </div>
          <Button
            type="submit"
            variant="outline"
            disabled={working || !link.trim()}
          >
            {linkOutcome === "pending" || linkOutcome === "unknown"
              ? "查询加入状态"
              : "查看邀请"}
          </Button>
        </form>
        {#if preview}
          <div class="chat-row keet-row">
            <strong>{preview.name || "Keet 房间"}</strong>
            {#if linkOutcome === "joined"}
              <span role="status">已加入房间</span>
            {:else if linkOutcome}
              <span role="status"
                >{linkOutcome === "pending"
                  ? "正在加入，请查询加入状态。"
                  : "加入结果待确认，请查询加入状态。"}</span
              >
            {:else}
              <Button disabled={working} onclick={joinLink}
                >{acceptLabel("group")}</Button
              >
            {/if}
          </div>
        {/if}
      {:else if section === "rooms"}
        <div class="section-head">
          <h3>已加入的聊天</h3>
          <Button
            variant="ghost"
            size="sm"
            disabled={working}
            onclick={() => run(readDirectory)}>重新读取聊天</Button
          >
        </div>
        {#if directory && !directory.items.length}<p class="hint">
            暂无已加入的房间或已接受的私聊。
          </p>{/if}
        {#each directory?.items ?? [] as item (item.conversation_id)}
          <div class="chat-row keet-row">
            {#if renaming === item.conversation_id}
              <form
                class="keet-rename"
                onsubmit={(event) => {
                  event.preventDefault();
                  void saveRoomName();
                }}
              >
                <label for="keet-room-name">Post 中的聊天名称</label>
                <Input
                  id="keet-room-name"
                  bind:value={roomName}
                  maxlength="256"
                  disabled={working}
                />
                <div class="actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={working}
                    onclick={() => {
                      renaming = null;
                    }}>取消</Button
                  >
                  <Button
                    type="submit"
                    size="sm"
                    disabled={working ||
                      !roomName.trim() ||
                      roomName.trim() === item.name}>保存名称</Button
                  >
                </div>
              </form>
            {:else}
              <span
                ><strong>{item.name}</strong>
                <small
                  >{item.type === "direct" ? "私聊" : "房间"}{item.writable
                    ? ""
                    : " · 只读"}</small
                ></span
              >
              <Button
                variant="ghost"
                size="sm"
                disabled={working}
                onclick={() => {
                  renaming = item.conversation_id;
                  roomName = item.name;
                }}>改名</Button
              >
            {/if}
          </div>
        {/each}
      {:else}
        <div class="section-head">
          <h3>Keet 资料</h3>
          <Button
            variant="ghost"
            size="sm"
            disabled={working}
            onclick={readProfile}>重新读取资料</Button
          >
        </div>
        {#if profile}
          <form
            onsubmit={(event) => {
              event.preventDefault();
              void saveProfile();
            }}
          >
            <div class="field">
              <label for="keet-nickname">Keet 昵称</label>
              <Input
                id="keet-nickname"
                maxlength="128"
                bind:value={displayName}
                disabled={working}
              />
              {#if (avatar || nicknameChanged) && !displayName.trim()}<small
                  >保存资料前，请先填写昵称。</small
                >{/if}
            </div>
            <div class="field">
              <span>Keet 头像</span>
              {#if currentAvatar}
                <img
                  class="keet-avatar"
                  src={"data:" +
                    currentAvatar.mime +
                    ";base64," +
                    currentAvatar.data_base64}
                  alt={avatar ? "新头像预览" : "当前 Keet 头像"}
                  width="72"
                  height="72"
                />
              {/if}
              <input
                id="keet-avatar"
                type="file"
                tabindex="-1"
                class="sr-only"
                aria-label="Keet 头像图片"
                accept={mimeTypes.join(",")}
                bind:this={avatarInput}
                disabled={working}
                onchange={chooseAvatar}
              />
              <div class="actions">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={working}
                  onclick={() => avatarInput.click()}>选择图片</Button
                >
              </div>
              <small>PNG、JPEG 或 WebP，最大 8 MiB。</small>
            </div>
            <Button
              type="submit"
              disabled={working ||
                profileUncertain ||
                !displayName.trim() ||
                (!nicknameChanged && !avatar)}
            >
              保存 Keet 资料
            </Button>
          </form>
        {/if}
      {/if}
      {#if error}<p role="alert">{error}</p>{/if}
      {#if notice}<p role="status">{notice}</p>{/if}
      {#if busy || applying}<p class="hint" role="status">
          {applying ? "Post 正在重新连接…" : "正在处理…"}
        </p>{/if}
    </div>

    <Dialog.Footer class="editor-footer">
      <Button variant="outline" onclick={close}>关闭</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<style>
  .keet-sections {
    flex-wrap: wrap;
  }
  .keet-row {
    justify-content: space-between;
    overflow-wrap: anywhere;
  }
  .keet-row small {
    display: block;
    margin-top: 4px;
  }
  .keet-form {
    margin-top: 24px;
  }
  .keet-rename {
    display: grid;
    gap: 8px;
    width: 100%;
  }
  .keet-avatar {
    border-radius: 50%;
    object-fit: cover;
    background: var(--muted);
  }
</style>
