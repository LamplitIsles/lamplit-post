import { boundedBytes } from "./io";
import { logger as sdkLogger } from "matrix-js-sdk/lib/logger.js";
import { Bot, Context } from "@koishijs/core";
import {
  MatrixClient,
  ClientEvent,
  RoomEvent,
  SyncState,
  MatrixEvent,
  Room,
  EventType,
  MsgType,
} from "matrix-js-sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import { opaque } from "./store";
import { need } from "./errors";
import type { Service } from "./service";
import type { AccountConfig, Scope } from "./config";
import type { Platform, Observation } from "./platform";
import type { ContentV1, MessageV1 } from "../contracts/v1/index";
/** Existing account access-token adapter. No AS registration or crypto device. */
export class MatrixUserBot
  extends Bot<Context, AccountConfig>
  implements Platform
{
  get nativeUserId() {
    return this.config.native_id;
  }
  client: MatrixClient;
  ready = false;
  live = false;
  stopped = false;
  pending = 0;
  chain: Promise<unknown> = Promise.resolve();
  operations = new AsyncLocalStorage<AbortSignal>();
  constructor(
    ctx: Context,
    config: AccountConfig,
    public service: Service,
    accessToken: string,
  ) {
    super(ctx, config, "matrix-user");
    this.platform = "matrix";
    this.user = { id: config.native_id };
    for (const key of [
      "trace",
      "debug",
      "info",
      "warn",
      "error",
      "log",
    ] as const)
      sdkLogger[key] = () => {};
    const quiet: any = {
      trace() {},
      debug() {},
      info() {},
      warn() {},
      error() {},
      getChild() {
        return this;
      },
    };
    sdkLogger.getChild = () => quiet;
    this.client = new MatrixClient({
      logger: quiet,
      baseUrl: config.homeserver!,
      accessToken,
      userId: config.native_id,
      localTimeoutMs: service.config.timeout_ms,
      useAuthorizationHeader: true,
      fetchFn: (async (input: any, init: any) => {
        const signal = this.service.signal(this.operations.getStore());
        const response = await fetch(input, {
          ...init,
          redirect: "error",
          signal: AbortSignal.any([
            signal,
            ...(init?.signal ? [init.signal] : []),
          ]),
        });
        const bytes = await boundedBytes(response, signal);
        return new Response(bytes, {
          status: response.status,
          headers: response.headers,
        });
      }) as typeof fetch,
    });
    this.client.on(ClientEvent.Sync, (state, _previous, data) => {
      this.live = state === SyncState.Syncing && data?.catchingUp === false;
      this.ready = state === SyncState.Prepared || state === SyncState.Syncing;
    });
    this.client.on(
      RoomEvent.Timeline,
      (event, room, toStart, removed, data) => {
        if (
          this.stopped ||
          toStart ||
          removed ||
          event.getSender() === config.native_id
        )
          return;
        if (
          !room ||
          event.isState() ||
          !["m.room.message", "m.room.redaction", "m.room.encrypted"].includes(
            event.getType(),
          )
        )
          return;
        if (++this.pending > 100) {
          this.service.errors.set(config.id, "capture_capacity");
          void this.service
            .track(this.service.store.gap(config.id, "capture_capacity"))
            .catch(() => {});
          this.client.stopClient();
          this.ready = false;
          return;
        }
        const catchup = !this.live || data?.liveEvent === false;
        this.chain = this.chain
          .then(() => this.capture(event, room, catchup))
          .catch(() => {
            this.service.errors.set(config.id, "capture_stopped");
            this.client.stopClient();
            this.ready = false;
          })
          .finally(() => {
            this.pending--;
          });
      },
    );
  }
  async start() {
    const identity = await this.operations.run(this.service.signal(), () =>
      this.client.whoami(),
    );
    need(identity.user_id === this.config.native_id, "conflict");
    await this.service.store.pin(this.config.id, "matrix", identity.user_id);
    await this.client.startClient({ initialSyncLimit: 20 });
    return;
  }
  async stop() {
    this.stopped = true;
    this.live = false;
    this.ready = false;
    this.client.stopClient();
    this.client.removeAllListeners();
    await this.chain;
    await super.stop();
  }
  async check(scope: Scope, signal: AbortSignal) {
    await this.operations.run(signal, async () => {
      const joined = await this.client.getJoinedRooms();
      need(joined.joined_rooms.includes(scope.native_id));
      const state = await this.client.roomState(scope.native_id);
      need(!state.some((e: any) => e.type === "m.room.encryption"));
      if (scope.type === "direct") {
        const roster = await this.client.getJoinedRoomMembers(scope.native_id);
        need(
          Object.keys(roster.joined)
            .filter((id) => id !== this.config.native_id)
            .every((id) => scope.senders.includes(id)),
        );
      }
    });
  }
  async members(scope: Scope, signal: AbortSignal) {
    try {
      const roster = await this.operations.run(signal, () =>
        this.client.getJoinedRoomMembers(scope.native_id),
      );
      const items = Object.entries(roster.joined)
        .map(([id, m]) => ({
          native_id: id,
          ...(typeof m.display_name === "string" && m.display_name.length <= 256
            ? { name: m.display_name }
            : {}),
        }))
        .sort((a, b) => a.native_id.localeCompare(b.native_id));
      return { items, capability: "supported" as const };
    } catch (e) {
      if ((e as any).httpStatus === 403)
        return { items: [], capability: "permission_required" as const };
      return { items: [], capability: "unavailable" as const };
    }
  }
  async capture(event: MatrixEvent, room: Room, catchup: boolean) {
    if (this.stopped) return;
    const c = event.getOriginalContent();
    const encrypted =
      room.hasEncryptionStateEvent() || event.getType() === "m.room.encrypted";
    if (encrypted) {
      await this.service.store.gap(
        this.config.id,
        "encrypted_room_unsupported",
      );
      return;
    }
    const content: ContentV1[] = [],
      assets: MessageV1["assets"] = [];
    const mentions = Array.isArray(c["m.mentions"]?.user_ids)
      ? c["m.mentions"].user_ids.filter((x: unknown) => typeof x === "string")
      : [];
    if (typeof c.body === "string")
      content.push({ type: "text", text: c.body });
    for (const id of mentions)
      content.push({ type: "mention", native_user_id: id });
    if (c.url || c.file) {
      const mime = c.info?.mimetype ?? "application/octet-stream";
      let asset;
      try {
        need(
          !c.file && typeof c.url === "string" && c.url.startsWith("mxc://"),
          "invalid_request",
        );
        const mxc = new URL(c.url);
        need(mxc.hostname && mxc.pathname.length > 1, "invalid_request");
        const endpoint = new URL(
          "/_matrix/client/v1/media/download/" +
            encodeURIComponent(mxc.host) +
            "/" +
            encodeURIComponent(mxc.pathname.slice(1)),
          this.config.homeserver,
        );
        const signal = this.service.signal();
        const token = this.client.getAccessToken()!;
        const res = await fetch(endpoint, {
          headers: { Authorization: "Bearer " + token },
          signal,
          redirect: "error",
        });
        need(res.ok, "unavailable");
        asset = await this.service.assets.ingest(
          res.body,
          mime,
          c.filename ?? c.body ?? "attachment",
          null,
          signal,
        );
      } catch {
        asset = await this.service.assets.unavailable(
          mime,
          String(c.body ?? "attachment").slice(0, 255),
          "download_unavailable",
        );
      }
      assets.push(asset);
      content.push({
        type:
          c.msgtype === "m.image"
            ? "image"
            : c.msgtype === "m.audio"
              ? "audio"
              : c.msgtype === "m.video"
                ? "video"
                : "file",
        asset_id: asset.asset_id,
      });
    }
    const mutation =
      event.getType() === "m.room.redaction"
        ? "retraction"
        : c["m.relates_to"]?.rel_type === "m.replace"
          ? "edit"
          : undefined;
    const o: Observation = {
      native_id: event.getId()!,
      conversation_native_id: room.roomId,
      conversation_type:
        this.service.config.bindings
          .flatMap((b) => b.scopes)
          .find(
            (s) =>
              s.account_id === this.config.id && s.native_id === room.roomId,
          )?.type ?? "group",
      sender: event.getSender()!,
      timestamp: event.getTs(),
      content,
      assets,
      mentions,
      self_mentioned: mentions.includes(this.config.native_id),
      reply_native_id: c["m.relates_to"]?.["m.in_reply_to"]?.event_id,
      mutation,
      catchup,
    };
    await this.service.observe(this.config.id, o);
    const session = this.session({
      type: mutation ? "message-updated" : "message",
      timestamp: o.timestamp,
      user: { id: o.sender },
      channel: {
        id: room.roomId,
        type: o.conversation_type === "direct" ? 1 : 0,
      },
      message: {
        id: o.native_id,
        content: typeof c.body === "string" ? c.body : "",
      },
    });
    this.dispatch(session);
  }
  async send(
    scope: Scope,
    part: ContentV1,
    reply: MessageV1 | null,
    signal: AbortSignal,
    _replySequence = 1,
    onDispatch: () => void = () => {},
  ) {
    return this.operations.run(signal, async () => {
      signal.throwIfAborted();
      let content: any;
      if (part.type === "text")
        content = { msgtype: MsgType.Text, body: part.text };
      else if (part.type === "mention")
        content = {
          msgtype: MsgType.Text,
          body: part.native_user_id,
          format: "org.matrix.custom.html",
          formatted_body: `<a href="https://matrix.to/#/${encodeURIComponent(part.native_user_id)}">${part.native_user_id.replace(/[&<>"']/g, "")}</a>`,
          "m.mentions": { user_ids: [part.native_user_id] },
        };
      else {
        const meta = await this.service.assets.metadata(part.asset_id),
          data = await this.service.assets.bytes(part.asset_id, signal);
        signal.throwIfAborted();
        onDispatch();
        const uploaded = await this.client.uploadContent(data, {
          name: meta.name,
          type: meta.mime,
        });
        content = {
          msgtype: part.type === "image" ? MsgType.Image : MsgType.File,
          body: meta.name,
          filename: meta.name,
          url: uploaded.content_uri,
          info: { mimetype: meta.mime, size: meta.size },
        };
      }
      if (reply)
        content["m.relates_to"] = {
          "m.in_reply_to": { event_id: reply.native_message_id },
        };
      signal.throwIfAborted();
      onDispatch();
      const result = await this.client.sendEvent(
        scope.native_id,
        EventType.RoomMessage,
        content,
        opaque("post"),
      );
      return [result.event_id];
    });
  }
}
