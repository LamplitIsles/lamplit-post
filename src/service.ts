import { $ } from "minato";
import { createHmac } from "node:crypto";
import { Config, Binding, Scope } from "./config";
import { Store, opaque, digest } from "./store";
import { Assets } from "./assets";
import { Fault, need } from "./errors";
import type { Observation, Platform } from "./platform";
import {
  Message,
  MessageV1,
  PostEventV1,
  ToolInputs,
  SendResult,
  ContentV1,
} from "../contracts/v1/index";
import type { z } from "zod";
type Send = z.infer<typeof SendResult>;
export class Service {
  assets: Assets;
  platforms = new Map<string, Platform>();
  errors = new Map<string, string>();
  stopSignal = new AbortController();
  jobs = new Set<Promise<unknown>>();
  closed = false;
  constructor(public store: Store) {
    this.assets = new Assets(store);
  }
  get config() {
    return this.store.config;
  }
  async seedConversations() {
    await this.store.db.transact(async (db) => {
      for (const b of this.config.bindings)
        for (const scope of b.scopes) {
          const r = (
            await db.get("post_conversations", { id: scope.conversation_id })
          )[0];
          if (r)
            need(
              r.account === scope.account_id &&
                r.native === scope.native_id &&
                r.type === scope.type,
              "conflict",
            );
          else
            await db.create("post_conversations", {
              id: scope.conversation_id,
              account: scope.account_id,
              native: scope.native_id,
              type: scope.type,
            });
        }
    });
  }
  track<T>(p: Promise<T>): Promise<T> {
    this.jobs.add(p);
    void p.finally(() => this.jobs.delete(p)).catch(() => {});
    return p;
  }
  signal(parent?: AbortSignal) {
    return AbortSignal.any([
      this.stopSignal.signal,
      AbortSignal.timeout(this.config.timeout_ms),
      ...(parent ? [parent] : []),
    ]);
  }
  active(agent: string) {
    return !this.store.owner.closed && this.store.tokens.has(agent);
  }
  bindings(agent: string) {
    need(this.active(agent));
    const bindings = this.config.bindings.filter((b) => b.agent_id === agent);
    need(bindings.length);
    return bindings;
  }
  scope(agent: string, account: string, conversation: string): Scope {
    const scope = this.bindings(agent)
      .flatMap((b) => b.scopes)
      .find(
        (s) =>
          s.account_id === account &&
          s.conversation_id === conversation &&
          this.admitsConversation(s),
      );
    need(scope);
    return scope;
  }
  admitsConversation(s: Scope) {
    if (s.type === "group") return true;
    return this.config.accounts.find((a) => a.id === s.account_id)?.platform ===
      "qq"
      ? s.senders.includes(s.native_id)
      : s.senders.length > 0;
  }
  admitted(b: Binding, m: MessageV1) {
    const s = b.scopes.find(
      (s) =>
        s.account_id === m.account_id &&
        s.conversation_id === m.conversation.id,
    );
    return (
      !!s &&
      this.admitsConversation(s) &&
      (s.type === "group" ||
        s.senders.includes(m.sender.native_id) ||
        m.direction === "outbound")
    );
  }
  visible(agent: string, m: MessageV1) {
    return this.bindings(agent).some((b) => this.admitted(b, m));
  }
  async message(id: string): Promise<MessageV1 | null> {
    const row = (await this.store.db.get("post_messages", { id }))[0];
    return row ? JSON.parse(row.body) : null;
  }
  async assetMessages(agent: string, id: string) {
    const links = await this.store.db.get("post_message_assets", { asset: id });
    const result: MessageV1[] = [];
    for (const link of links) {
      const m = await this.message(link.message);
      if (m && this.visible(agent, m)) {
        result.push(m);
        if (result.length === 100) break;
      }
    }
    return result;
  }
  async authorizeAsset(agent: string, id: string, signal: AbortSignal) {
    const row = await this.assets.row(id);
    need(row);
    if (row.owner === agent) return this.assets.metadata(id);
    for (const m of await this.assetMessages(agent, id)) {
      try {
        await this.check(agent, m.account_id, m.conversation.id, signal);
        return this.assets.metadata(id);
      } catch (e) {
        if (!(e instanceof Fault && e.code === "not_found")) throw e;
      }
    }
    throw new Fault("not_found");
  }
  capabilities(account: string) {
    return {
      members:
        this.config.accounts.find((a) => a.id === account)?.platform ===
        "matrix"
          ? "supported"
          : "unsupported",
      history: "observed",
      text: "supported",
      image: "supported",
      file: "supported",
      audio: "attachment",
      video: "attachment",
    };
  }
  wake(b: Binding, m: MessageV1) {
    if (m.direction === "outbound" || m.mutation) return null;
    if (m.conversation.type === "direct" && b.wake.direct)
      return "direct_message";
    if (m.mentions.self && b.wake.mention) return "mentioned";
    if (
      b.wake.reply &&
      m.reply?.verified &&
      m.reply.author_native_id ===
        this.platforms.get(m.account_id)?.nativeUserId
    )
      return "replied_to_self";
    if (
      b.wake.aliases.some((alias) =>
        m.content.some((c) => c.type === "text" && c.text.includes(alias)),
      )
    )
      return "alias_matched";
    return null;
  }
  async observe(
    account: string,
    o: Observation,
    direction: "inbound" | "outbound" = "inbound",
  ) {
    need(!this.closed, "unavailable");
    if (this.errors.has(account)) throw new Fault("unavailable");
    const a = this.config.accounts.find((a) => a.id === account)!;
    if (o.sender === a.native_id && direction === "inbound") return null;
    try {
      return (await this.store.db.transact(async (db) => {
        const conversationQuery = {
          account,
          native: o.conversation_native_id,
          type: o.conversation_type,
        };
        let conv = (await db.get("post_conversations", conversationQuery))[0];
        if (!conv)
          conv = await db.create("post_conversations", {
            id: opaque("cnv"),
            ...conversationQuery,
          });
        const native = o.mutation
          ? o.native_id + ":" + o.mutation
          : o.native_id;
        const duplicate = (
          await db.get("post_messages", {
            account,
            conversation: conv.id,
            native,
          })
        )[0];
        if (duplicate) return JSON.parse(duplicate.body) as MessageV1;
        const id = opaque("msg");
        const replied = o.reply_native_id
          ? (
              await db.get("post_messages", {
                account,
                conversation: conv.id,
                native: o.reply_native_id,
              })
            )[0]
          : null;
        const reply = replied ? (JSON.parse(replied.body) as MessageV1) : null;
        const m: MessageV1 = {
          id,
          account_id: account,
          platform: a.platform,
          conversation: {
            id: conv.id,
            native_id: conv.native,
            type: conv.type,
          },
          sender: { native_id: o.sender, ...(o.name ? { name: o.name } : {}) },
          timestamp: o.timestamp,
          sequence: 1,
          native_message_id: o.native_id,
          content: o.content,
          assets: o.assets,
          mentions: { self: o.self_mentioned, native_user_ids: o.mentions },
          reply: o.reply_native_id
            ? {
                message_id: reply?.id ?? null,
                native_message_id: o.reply_native_id,
                author_native_id: reply?.sender.native_id ?? null,
                verified: !!reply,
              }
            : null,
          direction,
          mutation: o.mutation ?? null,
        };

        const row = await db.create("post_messages", {
          id,
          account,
          conversation: conv.id,
          native,
          sender: o.sender,
          body: "",
        });
        m.sequence = row.seq;
        Message.parse(m);
        need(Buffer.byteLength(JSON.stringify(m)) <= 65536, "capacity");
        await db.set("post_messages", { id }, { body: JSON.stringify(m) });
        for (const asset of o.assets)
          await db.upsert("post_message_assets", [
            { asset: asset.asset_id, message: id },
          ]);
        if (!o.catchup)
          for (const b of this.config.bindings) {
            if (!this.active(b.agent_id) || !this.admitted(b, m)) continue;
            const reason = this.wake(b, m);
            if (!reason) continue;
            const count = await db.eval(
              "post_deliveries",
              (row) => $.count(row.id),
              { binding: b.id, state: ["pending", "held"] },
            );
            need(count < this.config.backlog_limit, "capacity");
            const event = PostEventV1.parse({
              schema_version: 1,
              type: "message",
              delivery_id: opaque("dlv"),
              agent_id: b.agent_id,
              message: m,
              wake: { reason },
            });
            await db.create("post_deliveries", {
              id: event.delivery_id,
              binding: b.id,
              agent: b.agent_id,
              message: id,
              receiver: b.receiver_url,
              body: JSON.stringify(event),
            });
          }
        return m;
      })) as MessageV1;
    } catch (e) {
      this.errors.set(account, e instanceof Fault ? e.code : "storage");
      try {
        await this.store.gap(account, "capture_stopped");
      } catch {}
      throw e;
    }
  }
  cursor(agent: string, query: string, offset: number) {
    const body = Buffer.from(
      JSON.stringify([
        digest(agent + ":" + query).slice(0, 32),
        offset,
        digest(JSON.stringify(this.bindings(agent))).slice(0, 32),
      ]),
    ).toString("base64url");
    return (
      body +
      "." +
      createHmac("sha256", this.store.key).update(body).digest("base64url")
    );
  }
  offset(agent: string, query: string, cursor?: string) {
    if (!cursor) return Number.MAX_SAFE_INTEGER;
    const [body, mac] = cursor.split(".");
    need(
      mac ===
        createHmac("sha256", this.store.key).update(body!).digest("base64url"),
      "invalid_request",
    );
    let value;
    try {
      value = JSON.parse(Buffer.from(body!, "base64url").toString());
    } catch {
      throw new Fault("invalid_request");
    }
    need(
      value[0] === digest(agent + ":" + query).slice(0, 32) &&
        value[2] === digest(JSON.stringify(this.bindings(agent))).slice(0, 32),
      "invalid_request",
    );
    return value[1] as number;
  }
  async call(
    agent: string,
    name: keyof typeof ToolInputs,
    input: unknown,
    parent?: AbortSignal,
  ): Promise<any> {
    need(!this.closed, "unavailable");
    const args = ToolInputs[name].parse(input) as any;
    const signal = this.signal(parent);
    this.bindings(agent);
    if (name === "list_accounts") {
      const ids = new Set(
        this.bindings(agent).flatMap((b) => b.scopes.map((s) => s.account_id)),
      );
      return {
        items: this.config.accounts
          .filter((a) => ids.has(a.id))
          .map((a) => ({
            account_id: a.id,
            platform: a.platform,
            native_id: a.native_id,
            ready: !!this.platforms.get(a.id)?.ready,
            capabilities: this.capabilities(a.id),
          })),
      };
    }
    if (name === "get_asset")
      return this.authorizeAsset(agent, args.asset_id, signal);
    if (name === "send_message") return this.send(agent, args, signal);
    if (name === "list_conversations") {
      const scopes = this.bindings(agent)
        .flatMap((b) => b.scopes)
        .filter((s) => s.account_id === args.account_id);
      need(scopes.length);
      const query = name + ":" + args.account_id;
      const offset = this.offset(agent, query, args.before);
      const rows = await this.store.db.get(
        "post_conversations",
        { account: args.account_id, seq: { $lt: offset } },
        { sort: { seq: "desc" }, limit: 101 },
      );
      const items = [];
      let last = 0;
      for (const r of rows) {
        last = r.seq;
        if (!scopes.some((s) => s.conversation_id === r.id)) continue;
        try {
          await this.check(agent, args.account_id, r.id, signal);
        } catch (e) {
          if (e instanceof Fault && e.code === "not_found") continue;
          throw e;
        }
        items.push(this.conversation(r));
        last = r.seq;
        if (items.length === (args.limit ?? 20)) break;
      }
      return {
        items,
        next_before:
          last && (rows.length === 101 || rows.some((r) => r.seq < last))
            ? this.cursor(agent, query, last)
            : null,
      };
    }
    const scope = await this.check(
      agent,
      args.account_id,
      args.conversation_id,
      signal,
    );
    const conv = (
      await this.store.db.get("post_conversations", {
        id: scope.conversation_id,
        account: scope.account_id,
      })
    )[0];
    need(conv);
    if (name === "get_conversation") return this.conversation(conv);
    const query = name + ":" + args.account_id + ":" + args.conversation_id,
      offset = this.offset(agent, query, args.before),
      limit = args.limit ?? 20;
    if (name === "list_members") {
      const result = await this.platforms
        .get(scope.account_id)!
        .members(scope, signal);
      const start = offset === Number.MAX_SAFE_INTEGER ? 0 : offset;
      const items = result.items.slice(start, start + limit);
      return {
        items,
        capability: result.capability,
        next_before:
          start + limit < result.items.length
            ? this.cursor(agent, query, start + limit)
            : null,
      };
    }
    const rows = await this.store.db.get(
      "post_messages",
      {
        account: scope.account_id,
        conversation: scope.conversation_id,
        seq: { $lt: offset },
      },
      { sort: { seq: "desc" }, limit: 101 },
    );
    const items: MessageV1[] = [];
    let last = 0,
      budget = 0;
    for (const r of rows) {
      const m = JSON.parse(r.body);
      if (!this.visible(agent, m)) {
        last = r.seq;
        continue;
      }
      const size = Buffer.byteLength(r.body);
      if (items.length && budget + size > 262144) break;
      items.push(m);
      budget += size;
      last = r.seq;
      if (items.length === limit) break;
    }
    return {
      items,
      next_before:
        last && (rows.length === 101 || rows.some((r) => r.seq < last))
          ? this.cursor(agent, query, last)
          : null,
    };
  }
  conversation(r: any) {
    return {
      account_id: r.account,
      conversation_id: r.id,
      native_id: r.native,
      type: r.type,
      ...(r.name ? { name: r.name } : {}),
      capabilities: this.capabilities(r.account),
    };
  }
  async check(
    agent: string,
    account: string,
    conversation: string,
    signal: AbortSignal,
  ) {
    const s = this.scope(agent, account, conversation);
    const p = this.platforms.get(account);
    need(p?.ready, "unavailable");
    await p.check(s, signal);
    signal.throwIfAborted();
    return s;
  }
  async send(agent: string, args: any, signal: AbortSignal): Promise<Send> {
    const scope = this.scope(agent, args.account_id, args.conversation_id);
    const serialized = JSON.stringify(args);
    const old = (
      await this.store.db.get("post_sends", { agent, request: args.request_id })
    )[0];
    if (old) {
      need(old.input === serialized, "conflict");
      return old.result
        ? JSON.parse(old.result)
        : {
            request_id: args.request_id,
            status: "unknown",
            parts: [],
            stored: false,
          };
    }
    await this.check(agent, args.account_id, args.conversation_id, signal);
    const reply = args.reply_to_message_id
      ? await this.message(args.reply_to_message_id)
      : null;
    if (args.reply_to_message_id)
      need(
        reply &&
          reply.account_id === scope.account_id &&
          reply.conversation.id === scope.conversation_id &&
          this.visible(agent, reply),
        "invalid_request",
      );
    if (
      reply &&
      this.config.accounts.find((a) => a.id === scope.account_id)?.platform ===
        "qq"
    )
      need(Date.now() - reply.timestamp < 295000, "invalid_request");
    for (const part of args.content as ContentV1[]) {
      if (part.type === "text")
        need(part.text.trim().length > 0, "invalid_request");
      if (part.type === "mention")
        need(/^[^<>\s]+$/.test(part.native_user_id), "invalid_request");
      if ("asset_id" in part) {
        const meta = await this.authorizeAsset(agent, part.asset_id, signal);
        need(meta.status === "available", "invalid_request");
        const bytes = await this.assets.bytes(part.asset_id, signal);
        if (part.type === "image")
          await this.assets.validateImage(meta.mime, bytes);
      }
      if (part.type === "mention")
        need(scope.type === "group", "invalid_request");
    }
    signal.throwIfAborted();
    const existing = await this.store.db.transact(async (db) => {
      const row = (
        await db.get("post_sends", { agent, request: args.request_id })
      )[0];
      if (row) return row;
      await db.create("post_sends", {
        agent,
        request: args.request_id,
        input: serialized,
        result: null,
      });
      return null;
    });
    if (existing) return this.send(agent, args, signal);
    const parts: Send["parts"] = [];
    let halted = false;
    let replySequence = 0;
    if (
      reply &&
      this.config.accounts.find((a) => a.id === scope.account_id)?.platform ===
        "qq"
    ) {
      replySequence = await this.store.db.transact(async (db) => {
        const query = {
          account: scope.account_id,
          native: reply.native_message_id,
        };
        const row = (await db.get("post_reply_sequences", query))[0];
        const start = row?.sequence ?? 0;
        await db.upsert("post_reply_sequences", [
          { ...query, sequence: start + args.content.length },
        ]);
        return start;
      });
    }

    for (const [index, part] of (args.content as ContentV1[]).entries()) {
      if (halted) {
        parts.push({
          index,
          status: "failed",
          native_message_ids: [],
          stored: false,
          error: "not_submitted",
        });
        continue;
      }
      let ids: string[] = [];
      let submitted = false;
      try {
        signal.throwIfAborted();
        await this.check(
          agent,
          scope.account_id,
          scope.conversation_id,
          signal,
        );
        ids = await this.platforms
          .get(scope.account_id)!
          .send(scope, part, reply, signal, replySequence + index + 1, () => {
            submitted = true;
          });
        need(ids.length, "unavailable");
      } catch (e) {
        const err = e as any;
        const rejects = (status: number) => status >= 400 && status < 500;
        const rejected =
          rejects(err.httpStatus) ||
          (Array.isArray(err.errors) &&
            err.errors.length > 0 &&
            err.errors.every((x: any) => rejects(x.response?.status)));
        parts.push({
          index,
          status: !submitted || rejected ? "failed" : "unknown",
          native_message_ids: ids,
          stored: false,
          error: !submitted
            ? "not_submitted"
            : rejected
              ? "platform_rejected"
              : "submission_unresolved",
        });
        halted = true;
        continue;
      }
      let stored = true;
      try {
        for (const native of ids)
          await this.observe(
            scope.account_id,
            {
              native_id: native,
              conversation_native_id: scope.native_id,
              conversation_type: scope.type,
              sender: this.platforms.get(scope.account_id)!.nativeUserId,
              timestamp: Date.now(),
              content: [part],
              assets:
                "asset_id" in part
                  ? [await this.assets.metadata(part.asset_id)]
                  : [],
              mentions: part.type === "mention" ? [part.native_user_id] : [],
              self_mentioned: false,
              catchup: true,
              reply_native_id: reply?.native_message_id,
            },
            "outbound",
          );
      } catch {
        stored = false;
      }
      parts.push({ index, status: "sent", native_message_ids: ids, stored });
      if (!stored) halted = true;
      // Save confirmed receipts before proceeding to another native part.
      try {
        await this.store.db.set(
          "post_sends",
          { agent, request: args.request_id },
          {
            result: JSON.stringify({
              request_id: args.request_id,
              status: "unknown",
              parts,
              stored: false,
            }),
          },
        );
      } catch {
        halted = true;
      }
    }
    const sent = parts.filter((p) => p.status === "sent").length;
    const result: Send = {
      request_id: args.request_id,
      status:
        sent === parts.length
          ? "sent"
          : sent
            ? "partial"
            : parts.some((p) => p.status === "unknown")
              ? "unknown"
              : "failed",
      parts,
      stored: parts.every((p) => p.stored),
    };
    try {
      await this.store.db.set(
        "post_sends",
        { agent, request: args.request_id },
        { result: JSON.stringify(result) },
      );
    } catch {}
    return result;
  }
  async dispatch(binding: Binding) {
    const row = (
      await this.store.db.get(
        "post_deliveries",
        { binding: binding.id, state: ["pending", "held"] },
        { sort: { seq: "asc" }, limit: 1 },
      )
    )[0];
    if (!row || row.due > Date.now()) return;
    const m = await this.message(row.message);
    const update = (value: any) =>
      this.store.db.set("post_deliveries", { id: row.id }, value);
    if (
      row.agent !== binding.agent_id ||
      !this.active(binding.agent_id) ||
      !m ||
      !this.admitted(binding, m)
    ) {
      await update({ state: "cancelled", category: "scope_revoked" });
      return;
    }
    if (row.receiver !== binding.receiver_url) {
      await update({ state: "held", category: "receiver_changed" });
      return;
    }
    try {
      await this.check(
        binding.agent_id,
        m.account_id,
        m.conversation.id,
        this.signal(),
      );
      const secret = await this.store.secret(
        binding.receiver_credential,
        binding.id,
        "receiver",
      );
      const response = await fetch(row.receiver, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + secret,
          "Content-Type": "application/json",
        },
        body: row.body,
        redirect: "manual",
        signal: this.signal(),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error();
      await update({ state: "accepted", category: null });
    } catch (e) {
      if (e instanceof Fault && e.code === "not_found") {
        await update({ state: "cancelled", category: "scope_revoked" });
        return;
      }
      if (!this.closed)
        await update({
          state: "pending",
          attempt: row.attempt + 1,
          due:
            Date.now() + Math.min(60000, 250 * 2 ** Math.min(row.attempt, 8)),
          category: "receiver_unavailable",
        });
    }
  }
  async startDispatch() {
    for (const row of await this.store.db.get("post_deliveries", {
      state: ["pending", "held"],
    }))
      if (!this.config.bindings.some((b) => b.id === row.binding))
        await this.store.db.set(
          "post_deliveries",
          { id: row.id },
          { state: "cancelled", category: "binding_removed" },
        );

    for (const b of this.config.bindings)
      this.track(
        (async () => {
          while (!this.closed && !this.errors.has(b.id)) {
            await this.dispatch(b).catch(() => {
              this.errors.set(b.id, "dispatch_storage");
            });
            await new Promise<void>((resolve) => {
              const t = setTimeout(done, 100);
              const signal = this.stopSignal.signal;
              function done() {
                clearTimeout(t);
                signal.removeEventListener("abort", done);
                resolve();
              }
              signal.addEventListener("abort", done, { once: true });
              if (signal.aborted) done();
            });
          }
        })(),
      );
  }
  async status() {
    const backlog = [];
    for (const state of ["pending", "held", "accepted", "cancelled"]) {
      const count = await this.store.db.eval(
        "post_deliveries",
        (r) => $.count(r.id),
        { state },
      );
      if (count) backlog.push({ state, count });
    }
    let full = false;
    for (const b of this.config.bindings)
      if (
        (await this.store.db.eval("post_deliveries", (r) => $.count(r.id), {
          binding: b.id,
          state: ["pending", "held"],
        })) >= this.config.backlog_limit
      )
        full = true;
    return {
      healthy:
        !backlog.some((r) => r.state === "held") &&
        !full &&
        !this.closed &&
        this.errors.size === 0 &&
        [...this.platforms.values()].every((p) => p.ready),
      accounts: [...this.platforms].map(([id, p]) => ({
        account_id: id,
        ready: p.ready,
        error: this.errors.get(id) ?? null,
      })),
      backlog,
      errors: [...this.errors].map(([scope, category]) => ({
        scope,
        category,
      })),
    };
  }
  async stop() {
    if (this.closed) return;
    this.closed = true;
    this.stopSignal.abort();
    await Promise.allSettled([...this.platforms.values()].map((p) => p.stop()));
    await Promise.allSettled([...this.jobs]);
  }
}
