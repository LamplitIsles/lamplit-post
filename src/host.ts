import { qqInbound } from "./diagnostics";
import { boundedBytes } from "./io";
import { HTTP } from "@cordisjs/plugin-http";
import { Context, h } from "@satorijs/core";
import { QQBot as QQ } from "@satorijs/adapter-qq";
import { decodeGroupMessage, type QQBot } from "@satorijs/adapter-qq";
import { AsyncLocalStorage } from "node:async_hooks";
import { MatrixUserBot } from "./matrix";
import type { Platform, Observation } from "./platform";
import type { AccountConfig, Scope } from "./config";
import type { Service } from "./service";
import type { ContentV1, MessageV1 } from "../contracts/v1/index";
import { need } from "./errors";
/** Native endpoint replacements exist only as an injected test seam, never in TOML/API. */
export interface TransportFixture {
  qqOrigin?: string;
  qqGateway?: string;
}
export class Host {
  sockets = new Set<any>();
  nativeBots = new Set<{ stop(): Promise<unknown> }>();
  forks: any[] = [];
  ctx: Context;
  operations = new AsyncLocalStorage<AbortSignal>();
  constructor(
    public service: Service,
    public fixture: TransportFixture = {},
    root: Context,
  ) {
    this.ctx = root;
    // Upstream loggers can include raw request/response bodies. Only Post safe categories are exported.

    if (!this.ctx.http)
      this.ctx.plugin(HTTP, { timeout: service.config.timeout_ms });
    this.ctx.http.defaultDecoder = async (response) =>
      JSON.parse(
        new TextDecoder().decode(
          await boundedBytes(
            response,
            service.signal(this.operations.getStore()),
          ),
        ),
      );
    const sockets = this.sockets;
    const ws = this.ctx.http.ws;
    this.ctx.http.ws = function (...args: Parameters<typeof ws>) {
      const socket = ws.apply(this, args);
      sockets.add(socket);
      socket.addEventListener("close", () => sockets.delete(socket), {
        once: true,
      });
      return socket;
    };
    this.ctx.on("http/websocket-init", (_url, options) => {
      options.maxPayload = 4 * 1024 * 1024;
    });
    this.ctx.on("http/fetch-init", (url, init) => {
      if (
        fixture.qqOrigin &&
        ["bots.qq.com", "api.bot.qq.com"].includes(url.hostname)
      ) {
        const base = new URL(fixture.qqOrigin);
        url.protocol = base.protocol;
        url.host = base.host;
      }
      init.redirect = "error";
      init.signal = AbortSignal.any([
        service.signal(this.operations.getStore()),
        ...(init.signal ? [init.signal] : []),
      ]);
    });
  }
  async start() {
    for (const config of this.service.config.accounts) {
      this.service.stopSignal.signal.throwIfAborted();
      const secret = await this.service.store.secret(
        config.credential,
        config.id,
        "platform",
      );
      this.service.stopSignal.signal.throwIfAborted();
      if (config.platform === "matrix") {
        this.forks.push(
          this.ctx.plugin((ctx: Context) => {
            const bot = new MatrixUserBot(ctx, config, this.service, secret);
            this.nativeBots.add(bot);
            this.service.platforms.set(config.id, bot);
          }),
        );
      } else {
        const existing = new Set(this.ctx.bots);
        this.forks.push(
          this.ctx.plugin(QQ as any, {
            id: config.native_id,
            secret,
            token: "",
            type: "public",
            protocol: "websocket",
            intents: (1 << 25) | (1 << 30),
            retryWhen: [],
            // Core's first established socket retains its initial-attempt close path.
            // Allow it to enter connection recovery; outgoing retries stay disabled.
            retryTimes: 1,
            retryInterval: 1000,
            retryLazy: 1000,
            endpoint: this.fixture.qqOrigin ?? "https://api.bot.qq.com",
            gatewayUrl: this.fixture.qqGateway,
            timeout: this.service.config.timeout_ms,
          }),
        );
        for (const bot of this.ctx.bots)
          if (!existing.has(bot)) this.nativeBots.add(bot);
      }
    }

    this.service.stopSignal.signal.throwIfAborted();
    for (const config of this.service.config.accounts) {
      if (config.platform === "qq") {
        const bot = this.ctx.bots.find(
          (b) =>
            b.platform === "qq" && (b.config as any).id === config.native_id,
        ) as unknown as QQBot;
        need(bot, "unavailable");
        const platform = new QQPlatform(config, bot, this);
        this.service.platforms.set(config.id, platform);
        this.ctx.on("message", (session) => {
          if (
            session.bot.platform !== "qq" ||
            (session.bot.config as any).id !== config.native_id
          )
            return;
          platform.enqueue(session);
        });
        await platform.start();
      }
    }
    const signal = this.service.signal();
    while ([...this.service.platforms.values()].some((p) => !p.ready)) {
      signal.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  async stop() {
    await Promise.allSettled([...this.nativeBots].map((bot) => bot.stop()));
    await Promise.all(
      [...this.sockets].map(
        (socket) =>
          new Promise<void>((resolve) => {
            if (socket.readyState === 3) {
              resolve();
              return;
            }
            const timer = setTimeout(() => {
              socket.terminate?.();
              resolve();
            }, 1000);
            socket.addEventListener(
              "close",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
            if (socket.readyState === 1) socket.close();
          }),
      ),
    );
    for (const fork of this.forks.reverse()) {
      fork.dispose();
    }
  }
}
export class QQPlatform implements Platform {
  get nativeUserId() {
    return this.bot.selfId;
  }
  get ready() {
    return (
      !this.stopped &&
      this.bot.status === 1 &&
      !this.service.errors.has(this.config.id)
    );
  }
  stopped = false;
  chain: Promise<unknown> = Promise.resolve();
  pending = 0;
  startedAt = Date.now();
  constructor(
    public config: AccountConfig,
    public bot: QQBot,
    public host: Host,
  ) {
    host.ctx.on("bot-status-updated", (bot) => {
      if (
        bot.platform === "qq" &&
        (bot.config as any).id === config.native_id
      ) {
        if (!this.service.closed && !this.service.store.owner.closed)
          void this.service.track(this.service.status()).catch(() => {});
        if (bot.status === 1) this.startedAt = Date.now();
        else if (!this.stopped)
          void host.service
            .track(host.service.store.gap(config.id, "connection_gap"))
            .catch(() => {});
      }
    });
  }
  get service() {
    return this.host.service;
  }
  async start() {
    const signal = this.service.signal();
    while (this.bot.status !== 1) {
      signal.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await this.service.store.pin(this.config.id, "qq", this.config.native_id);
    return;
  }
  async stop() {
    this.stopped = true;
    try {
      await this.bot.stop();
    } finally {
      await this.chain;
    }
  }
  async check(_scope: Scope, signal: AbortSignal) {
    signal.throwIfAborted();
    need(this.bot.status === 1, "unavailable");
  }
  async members(_scope: Scope, _signal: AbortSignal) {
    return { items: [], capability: "unsupported" as const };
  }
  async groupName(native: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const guild = await this.host.operations.run(signal, () =>
      this.bot.getGuild(native),
    );
    signal.throwIfAborted();
    return guild.id === native && typeof guild.name === "string"
      ? guild.name.trim().slice(0, 256) || undefined
      : undefined;
  }
  enqueue(session: any) {
    const type = session.isDirect ? "direct" : "group";
    const event = session.qq?.t;
    const native_event =
      event === "GROUP_MESSAGE_CREATE" ||
      event === "GROUP_AT_MESSAGE_CREATE" ||
      event === "C2C_MESSAGE_CREATE"
        ? event
        : "other";
    if (this.stopped) {
      qqInbound({
        stage: "sdk_capture",
        type,
        native_event,
        category: "stopped",
      });
      return;
    }
    if (++this.pending > 100) {
      qqInbound({
        stage: "sdk_capture",
        type,
        native_event,
        category: "capacity",
      });
      this.service.errors.set(this.config.id, "capture_capacity");
      void this.service
        .track(this.service.store.gap(this.config.id, "capture_capacity"))
        .catch(() => {});
      void this.stop();
      return;
    }
    qqInbound({ stage: "sdk_capture", type, native_event, category: "queued" });
    this.chain = this.chain
      .then(() => this.capture(session))
      .catch(() => {
        qqInbound({
          stage: "sdk_capture",
          type,
          native_event,
          category: "capture_failed",
        });
        this.service.errors.set(this.config.id, "capture_stopped");
        void this.bot.stop();
      })
      .finally(() => {
        this.pending--;
      });
  }
  async capture(session: any) {
    if (this.stopped) return;
    const content: ContentV1[] = [],
      assets: MessageV1["assets"] = [];
    const native = session.qq?.d ?? {};
    const mentions = (native.mentions ?? [])
      .filter((m: any) => m.scope === "single")
      .map((m: any) => m.id);
    if (native?.author?.id === this.nativeUserId) return;
    // Preserve native mention IDs through the published decoder without its bot-ID substitution.
    const elements =
      typeof native.content === "string"
        ? decodeGroupMessage(this.bot, {
            ...native,
            mentions: (native.mentions ?? []).map((m: any) => ({
              ...m,
              is_you: false,
            })),
          }).elements
        : session.elements;
    for (const element of elements ?? []) {
      const a = element.attrs;
      if (element.type === "text")
        content.push({ type: "text", text: String(a.content) });
      else if (element.type === "at" && a.id)
        content.push({ type: "mention", native_user_id: a.id });
      else if (
        ["img", "image", "file", "audio", "video"].includes(element.type)
      ) {
        const attachment = (native.attachments ?? []).find(
          (x: any) => x.url === a.src,
        );
        const mime = attachment?.content_type?.includes("/")
          ? attachment.content_type
          : element.type === "audio"
            ? "audio/ogg"
            : "application/octet-stream";
        let asset;
        try {
          const url = new URL(a.src);
          need(
            url.protocol === "https:" || !!this.host.fixture.qqOrigin,
            "invalid_request",
          );
          need(!url.username && !url.password, "invalid_request");
          const signal = this.service.signal();
          const response = await fetch(url, { redirect: "error", signal });
          need(response.ok, "unavailable");
          asset = await this.service.assets.ingest(
            response.body,
            mime,
            attachment?.filename ?? "attachment",
            null,
            signal,
          );
        } catch {
          asset = await this.service.assets.unavailable(
            mime,
            "attachment",
            "download_unavailable",
          );
        }
        assets.push(asset);
        content.push({
          type: element.type === "img" ? "image" : element.type,
          asset_id: asset.asset_id,
        } as ContentV1);
      }
    }
    const replyId = native.message_reference?.message_id;
    const o: Observation = {
      native_id: session.messageId,
      conversation_native_id: session.channelId,
      conversation_type: session.isDirect ? "direct" : "group",
      sender: session.userId,
      name: session.event.user?.name,
      timestamp: session.timestamp,
      content,
      assets,
      mentions,
      self_mentioned:
        session.qq?.t === "GROUP_AT_MESSAGE_CREATE" ||
        (native.mentions ?? []).some(
          (m: any) => m.scope === "single" && m.is_you === true,
        ),
      reply_native_id: replyId,
      catchup: session.timestamp < this.startedAt,
    };
    await this.service.observe(this.config.id, o);
  }
  async send(
    scope: Scope,
    part: ContentV1,
    reply: MessageV1 | null,
    signal: AbortSignal,
    replySequence = 1,
    onDispatch: () => void = () => {},
  ) {
    return this.host.operations.run(signal, async () => {
      const session = this.bot.session({
        channel: { id: scope.native_id, type: scope.type === "direct" ? 1 : 0 },
        user: {
          id: scope.type === "direct" ? scope.native_id : this.config.native_id,
        },
        timestamp: reply?.timestamp ?? Date.now(),
        message: reply ? { id: reply.native_message_id } : undefined,
      });
      let fragment: h.Fragment;
      if (part.type === "text") fragment = h.text(part.text);
      // The published group encoder has no at visitor; use its public native text syntax.
      else if (part.type === "mention")
        fragment = h.text(`<@${part.native_user_id}>`);
      else {
        const meta = await this.service.assets.metadata(part.asset_id);
        const bytes = await this.service.assets.bytes(part.asset_id, signal);
        fragment = h(part.type === "image" ? "img" : "file", {
          src: `data:${meta.mime};base64,${bytes.toString("base64")}`,
          title: meta.name,
        });
      }
      if (reply) {
        need(Date.now() - reply.timestamp < 295000, "invalid_request");
        fragment = [
          h("passive", {
            messageId: reply.native_message_id,
            seq: replySequence,
          }),
          h.quote(reply.native_message_id),
          fragment,
        ];
      }
      signal.throwIfAborted();
      onDispatch();
      const results = await this.bot.createMessage(
        scope.native_id,
        fragment,
        undefined,
        { session: session as any },
      );
      return results.map((r) => r.id).filter(Boolean) as string[];
    });
  }
}
