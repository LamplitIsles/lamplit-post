import { qqInbound } from "./diagnostics";
import type { Tables } from "./models";
import { createHmac } from "node:crypto";
import { Config, Binding, Scope, accountOwner } from "./config";
import { Store, opaque, digest, checkConversationPin } from "./store";
import { Assets } from "./assets";
import { Fault, need } from "./errors";
import { ensureConversationName } from "./conversation-name";
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
    this.seedConversations();
  }
  get config() {
    return this.store.config;
  }
  seedConversations() {
    this.store.transaction((db) => {
      for (const b of this.config.bindings)
        for (const scope of b.scopes) {
          let r = (
            db
              .prepare("SELECT * FROM conversations WHERE `id` = ?")
              .all(
                scope.conversation_id,
              ) as unknown as Tables["conversations"][]
          )[0];
          if (r) checkConversationPin(r, scope);
          else
            r = db
              .prepare(
                "INSERT INTO conversations (`id`,`account`,`native`,`type`) VALUES (?,?,?,?) RETURNING *",
              )
              .get(
                scope.conversation_id,
                scope.account_id,
                scope.native_id,
                scope.type,
              ) as unknown as Tables["conversations"];
          const account = this.config.accounts.find(
            (a) => a.id === scope.account_id,
          )!;
          ensureConversationName(db, r, account.platform);
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
    return (
      !this.store.owner.closed &&
      this.store.tokens.has(agent) &&
      this.config.agents.some((a) => a.id === agent)
    );
  }
  bindings(agent: string) {
    need(this.active(agent));
    const bindings = this.config.bindings.filter(
      (b) => b.agent_id === agent && b.enabled,
    );
    return bindings;
  }
  hasGrants(agent: string) {
    return this.bindings(agent).some((b) =>
      b.scopes.some(
        (s) =>
          accountOwner(this.config, s.account_id) === agent &&
          this.admitsConversation(s),
      ),
    );
  }
  scope(agent: string, account: string, conversation: string): Scope {
    const scope = this.bindings(agent)
      .flatMap((b) => b.scopes)
      .find(
        (s) =>
          s.account_id === account &&
          accountOwner(this.config, account) === agent &&
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
      b.enabled &&
      accountOwner(this.config, m.account_id) === b.agent_id &&
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
    const row = (
      this.store.db
        .prepare("SELECT * FROM messages WHERE `id` = ?")
        .all(id) as unknown as Tables["messages"][]
    )[0];
    return row ? JSON.parse(row.body) : null;
  }
  async assetMessages(agent: string, id: string) {
    const links = this.store.db
      .prepare("SELECT * FROM message_assets WHERE `asset` = ?")
      .all(id) as unknown as Tables["message_assets"][];
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
    need(this.hasGrants(agent));
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
    const diagnostic = a.platform === "qq" && direction === "inbound";
    const summary = {
      bindings: 0,
      inactive: 0,
      disabled: 0,
      scope_missing: 0,
      peer_denied: 0,
      admitted: 0,
      wake_none: 0,
      wake_direct: 0,
      wake_mention: 0,
      wake_reply: 0,
      wake_alias: 0,
      deliveries_created: 0,
    };
    let duplicateObservation = false;
    if (o.sender === a.native_id && direction === "inbound") {
      if (diagnostic)
        qqInbound({
          stage: "observation",
          type: o.conversation_type,
          category: "self",
        });
      return null;
    }
    try {
      const result = this.store.transaction((db) => {
        let conv = db
          .prepare(
            "SELECT * FROM conversations WHERE account=? AND native=? AND type=?",
          )
          .get(
            account,
            o.conversation_native_id,
            o.conversation_type,
          ) as unknown as Tables["conversations"];
        const created = !conv;
        if (!conv)
          conv = db
            .prepare(
              "INSERT INTO conversations(id,account,native,type) VALUES(?,?,?,?) RETURNING *",
            )
            .get(
              opaque("cnv"),
              account,
              o.conversation_native_id,
              o.conversation_type,
            ) as unknown as Tables["conversations"];
        ensureConversationName(
          db,
          conv,
          a.platform,
          created && a.platform === "qq" && direction === "inbound"
            ? conv.type === "direct"
              ? o.name
              : o.conversation_name
            : undefined,
        );
        const native = o.mutation
          ? o.native_id + ":" + o.mutation
          : o.native_id;
        const duplicate = (
          db
            .prepare(
              "SELECT * FROM messages WHERE `account` = ? AND `conversation` = ? AND `native` = ?",
            )
            .all(account, conv.id, native) as unknown as Tables["messages"][]
        )[0];
        if (duplicate) {
          duplicateObservation = true;
          return JSON.parse(duplicate.body) as MessageV1;
        }
        const id = opaque("msg");
        const replied = o.reply_native_id
          ? (
              db
                .prepare(
                  "SELECT * FROM messages WHERE `account` = ? AND `conversation` = ? AND `native` = ?",
                )
                .all(
                  account,
                  conv.id,
                  o.reply_native_id,
                ) as unknown as Tables["messages"][]
            )[0]
          : null;
        const reply = replied ? (JSON.parse(replied.body) as MessageV1) : null;
        const currentName = conv.name!;
        const m: MessageV1 = {
          id,
          account_id: account,
          platform: a.platform,
          conversation: {
            id: conv.id,
            native_id: conv.native,
            type: conv.type,
            name: currentName,
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

        const row = db
          .prepare(
            "INSERT INTO messages (`id`,`account`,`conversation`,`native`,`sender`,`body`) VALUES (?,?,?,?,?,?) RETURNING *",
          )
          .get(
            id,
            account,
            conv.id,
            native,
            o.sender,
            "",
          ) as unknown as Tables["messages"];
        m.sequence = row.seq;
        Message.parse(m);
        need(Buffer.byteLength(JSON.stringify(m)) <= 65536, "capacity");
        db.prepare("UPDATE messages SET `body` = ? WHERE `id` = ?").run(
          JSON.stringify(m),
          id,
        );
        for (const asset of o.assets)
          db.prepare(
            "INSERT INTO message_assets (`asset`,`message`) VALUES (?,?) ON CONFLICT DO UPDATE SET `asset` = excluded.`asset`,`message` = excluded.`message`",
          ).run(asset.asset_id, id);
        if (!o.catchup)
          for (const b of this.config.bindings) {
            summary.bindings++;
            if (!this.active(b.agent_id)) {
              summary.inactive++;
              continue;
            }
            if (!this.admitted(b, m)) {
              if (!b.enabled) summary.disabled++;
              else if (
                !b.scopes.some(
                  (s) =>
                    s.account_id === m.account_id &&
                    s.conversation_id === m.conversation.id,
                )
              )
                summary.scope_missing++;
              else summary.peer_denied++;
              continue;
            }
            summary.admitted++;
            const reason = this.wake(b, m);
            if (!reason) {
              summary.wake_none++;
              continue;
            }
            if (reason === "direct_message") summary.wake_direct++;
            else if (reason === "mentioned") summary.wake_mention++;
            else if (reason === "replied_to_self") summary.wake_reply++;
            else summary.wake_alias++;
            const count = (
              db
                .prepare(
                  "SELECT count(*) AS n FROM deliveries WHERE `binding` = ? AND `state` IN (?,?)",
                )
                .get(b.id, ...["pending", "held"]) as unknown as { n: number }
            ).n;
            need(count < this.config.backlog_limit, "capacity");
            const event = PostEventV1.parse({
              schema_version: 1,
              type: "message",
              delivery_id: opaque("dlv"),
              agent_id: b.agent_id,
              message: m,
              wake: { reason },
            });
            db
              .prepare(
                "INSERT INTO deliveries (`id`,`binding`,`agent`,`message`,`receiver`,`body`) VALUES (?,?,?,?,?,?) RETURNING *",
              )
              .get(
                event.delivery_id,
                b.id,
                b.agent_id,
                id,
                this.config.agents.find((a) => a.id === b.agent_id)!
                  .receiver_url,
                JSON.stringify(event),
              ) as unknown as Tables["deliveries"];
            summary.deliveries_created++;
          }
        return m;
      }) as MessageV1;
      // Report committed outcomes only, outside the synchronous transaction.
      if (diagnostic)
        qqInbound({
          stage: "observation",
          type: o.conversation_type,
          category: duplicateObservation
            ? "duplicate"
            : o.catchup
              ? "catchup"
              : "archived",
          ...summary,
        });
      return result;
    } catch (e) {
      if (diagnostic)
        qqInbound({
          stage: "observation",
          type: o.conversation_type,
          category: "observation_failed",
        });
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
    const parsed = ToolInputs[name].safeParse(input);
    if (!parsed.success)
      throw new Fault(
        "invalid_request",
        "Invalid tool arguments. Check the tool schema.",
      );
    const args = parsed.data as any;
    const signal = this.signal(parent);
    this.bindings(agent);
    if (name === "list_accounts") {
      const ids = new Set(
        this.bindings(agent).flatMap((b) => b.scopes.map((s) => s.account_id)),
      );
      return {
        items: this.config.accounts
          .filter(
            (a) => ids.has(a.id) && accountOwner(this.config, a.id) === agent,
          )
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
        .filter(
          (s) =>
            s.account_id === args.account_id &&
            accountOwner(this.config, s.account_id) === agent,
        );
      need(scopes.length);
      const query = name + ":" + args.account_id;
      const offset = this.offset(agent, query, args.before);
      const rows = this.store.db
        .prepare(
          "SELECT * FROM conversations WHERE `account` = ? AND `seq` < ? ORDER BY `seq` DESC LIMIT ?",
        )
        .all(
          args.account_id,
          offset,
          101,
        ) as unknown as Tables["conversations"][];
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
    const selection = await this.conversationTarget(agent, args, signal);
    selection.validate();
    const { scope } = selection;
    const conv = (
      this.store.db
        .prepare("SELECT * FROM conversations WHERE `id` = ? AND `account` = ?")
        .all(
          scope.conversation_id,
          scope.account_id,
        ) as unknown as Tables["conversations"][]
    )[0];
    need(conv);
    if (name === "get_conversation") return this.conversation(conv);
    const query = name + ":" + scope.account_id + ":" + scope.conversation_id,
      offset = this.offset(agent, query, args.before),
      limit = args.limit ?? 20;
    if (name === "list_members") {
      const result = await this.platforms
        .get(scope.account_id)!
        .members(scope, signal);
      selection.validate();
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
    const rows = this.store.db
      .prepare(
        "SELECT * FROM messages WHERE `account` = ? AND `conversation` = ? AND `seq` < ? ORDER BY `seq` DESC LIMIT ?",
      )
      .all(
        scope.account_id,
        scope.conversation_id,
        offset,
        101,
      ) as unknown as Tables["messages"][];
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
    const platform = this.config.accounts.find(
      (a) => a.id === r.account,
    )!.platform;
    return {
      account_id: r.account,
      conversation_id: r.id,
      native_id: r.native,
      type: r.type,
      name: r.name?.trim()
        ? r.name
        : this.store.transaction((db) =>
            ensureConversationName(db, r, platform),
          ),
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
  /** First admission only: names select existing authority; they never create it. */
  private async conversationTarget(
    agent: string,
    args: any,
    signal: AbortSignal,
  ) {
    const candidates = () => {
      const found = new Map<string, Scope>();
      for (const b of this.bindings(agent))
        for (const s of b.scopes) {
          if (
            accountOwner(this.config, s.account_id) !== agent ||
            !this.admitsConversation(s) ||
            (args.account_id !== undefined &&
              s.account_id !== args.account_id) ||
            (args.conversation_type !== undefined &&
              s.type !== args.conversation_type)
          )
            continue;
          const account = this.config.accounts.find(
            (a) => a.id === s.account_id,
          );
          if (
            !account ||
            (args.platform !== undefined && account.platform !== args.platform)
          )
            continue;
          const row = this.store.db
            .prepare("SELECT * FROM conversations WHERE account=? AND id=?")
            .get(s.account_id, s.conversation_id);
          if (row && this.conversation(row).name === args.conversation_name)
            found.set(JSON.stringify([s.account_id, s.conversation_id]), s);
        }
      return found;
    };
    const before = candidates();
    const eligible: Scope[] = [];
    for (const s of before.values()) {
      try {
        eligible.push(
          await this.check(agent, s.account_id, s.conversation_id, signal),
        );
      } catch (e) {
        if (!(e instanceof Fault && e.code === "not_found")) throw e;
      }
    }
    if (!eligible.length)
      throw new Fault(
        "not_found",
        "No admitted conversation has that exact current name. Use a name from list_conversations.",
      );
    if (eligible.length > 1)
      throw new Fault(
        "conflict",
        "Several admitted conversations have that exact name. Specify account_id, platform or conversation_type, or ask the administrator to give them distinct names. Choices (at most 8): " +
          JSON.stringify(
            eligible.slice(0, 8).map((s) => ({
              conversation_name: args.conversation_name,
              platform: this.config.accounts.find((a) => a.id === s.account_id)!
                .platform,
              conversation_type: s.type,
              account_id: s.account_id,
            })),
          ),
      );
    const scope = eligible[0]!;
    const keys = (values: Map<string, Scope>) =>
      JSON.stringify([...values.keys()].sort());
    return {
      scope,
      validate: () => {
        need(keys(candidates()) === keys(before), "conflict");
        this.scope(agent, scope.account_id, scope.conversation_id);
      },
    };
  }
  private async mentionContent(
    agent: string,
    scope: Scope,
    content: any[],
    signal: AbortSignal,
  ) {
    if (!content.some((p) => p.type === "mention" && p.name !== undefined))
      return { content: content as ContentV1[], validate: () => {} };
    need(scope.type === "group", "invalid_request");
    const qq =
      this.config.accounts.find((a) => a.id === scope.account_id)!.platform ===
      "qq";
    const observed = () => {
      const speakers = new Map<string, string>();
      for (const row of this.store.db
        .prepare(
          "SELECT body FROM messages WHERE account=? AND conversation=? ORDER BY seq DESC",
        )
        .iterate(scope.account_id, scope.conversation_id)) {
        const m = JSON.parse(row.body as string) as MessageV1;
        if (m.direction !== "inbound" || m.mutation || !this.visible(agent, m))
          continue;
        const { native_id: id, name } = m.sender;
        if (!speakers.has(id) && typeof name === "string" && name.trim())
          speakers.set(id, name.trim().slice(0, 256));
      }
      return [...speakers]
        .filter(([id, name]) => name !== id)
        .map(([native_id, name]) => ({ native_id, name }));
    };
    const members = qq
      ? { items: observed(), capability: "supported" }
      : await this.platforms.get(scope.account_id)!.members(scope, signal);
    signal.throwIfAborted();
    if (members.capability !== "supported")
      throw new Fault(
        "unavailable",
        "Member names are unavailable for this conversation; no mention was submitted. Use a known native_user_id instead.",
      );
    const resolve = (
      items: { native_id: string; name?: string }[],
    ): ContentV1[] =>
      content.map((part) => {
        if (part.type !== "mention" || part.name === undefined) return part;
        const matches = [
          ...new Set(
            items
              .filter(
                (m) => m.name && m.name !== m.native_id && m.name === part.name,
              )
              .map((m) => m.native_id),
          ),
        ];
        if (!matches.length)
          throw new Fault(
            "not_found",
            qq
              ? "No observed speaker in this chat has that exact name. Observations are incomplete and are not a current roster; use a known native_user_id."
              : "No joined member has that exact name; use a known native_user_id.",
          );
        if (matches.length > 1)
          throw new Fault(
            "conflict",
            "Several members have that exact name. Use native_user_id. Choices (at most 8): " +
              JSON.stringify(
                matches.slice(0, 8).map((native_user_id) => ({
                  name: part.name,
                  native_user_id,
                })),
              ),
          );
        return { type: "mention", native_user_id: matches[0]! };
      });
    const resolved = resolve(members.items);
    return {
      content: resolved,
      validate: () => {
        if (qq)
          need(
            JSON.stringify(resolve(observed())) === JSON.stringify(resolved),
            "conflict",
          );
      },
    };
  }
  async send(agent: string, args: any, signal: AbortSignal): Promise<Send> {
    const serialized = JSON.stringify(args);
    const old = (
      this.store.db
        .prepare("SELECT * FROM sends WHERE `agent` = ? AND `request` = ?")
        .all(agent, args.request_id) as unknown as Tables["sends"][]
    )[0];
    if (old) {
      const stored = JSON.parse(old.input);
      const accepted =
        typeof stored.caller === "string"
          ? { caller: JSON.parse(stored.caller), target: stored.target }
          : { caller: stored, target: stored };
      // Reconcile the durable pin without reselecting the current name.
      this.scope(
        agent,
        accepted.target.account_id,
        accepted.target.conversation_id,
      );
      if (accepted.caller.conversation_name !== undefined) {
        need(JSON.stringify(accepted.caller) === serialized, "conflict");
        await this.check(
          agent,
          accepted.target.account_id,
          accepted.target.conversation_id,
          signal,
        );
        this.scope(
          agent,
          accepted.target.account_id,
          accepted.target.conversation_id,
        );
      } else {
        const selection = await this.conversationTarget(agent, args, signal);
        selection.validate();
        need(
          selection.scope.account_id === accepted.target.account_id &&
            selection.scope.conversation_id ===
              accepted.target.conversation_id &&
            JSON.stringify(accepted.caller.content) ===
              JSON.stringify(args.content) &&
            accepted.caller.reply_to_message_id === args.reply_to_message_id,
          "conflict",
        );
      }
      return old.result
        ? JSON.parse(old.result)
        : {
            request_id: args.request_id,
            status: "unknown",
            parts: [],
            stored: false,
          };
    }
    const selection = await this.conversationTarget(agent, args, signal);
    const { scope } = selection;
    const mentions = await this.mentionContent(
      agent,
      scope,
      args.content,
      signal,
    );
    const content = mentions.content;
    const input = JSON.stringify({
      caller: serialized,
      target: {
        account_id: scope.account_id,
        conversation_id: scope.conversation_id,
      },
      content,
    });
    const reply = args.reply_to_message_id
      ? await this.message(args.reply_to_message_id)
      : null;
    if (
      args.reply_to_message_id &&
      !(
        reply &&
        reply.account_id === scope.account_id &&
        reply.conversation.id === scope.conversation_id &&
        this.visible(agent, reply)
      )
    )
      throw new Fault(
        "invalid_request",
        "reply_to_message_id must identify an admitted Post message in the same account and conversation; native platform IDs are not accepted.",
      );
    if (
      reply &&
      this.config.accounts.find((a) => a.id === scope.account_id)?.platform ===
        "qq"
    )
      if (!(Date.now() - reply.timestamp < 295000))
        throw new Fault(
          "invalid_request",
          "QQ reference reply requires a Post message less than 295 seconds old. Nothing was submitted.",
        );
    for (const part of content) {
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
    const existing = this.store.transaction((db) => {
      const row = (
        db
          .prepare("SELECT * FROM sends WHERE `agent` = ? AND `request` = ?")
          .all(agent, args.request_id) as unknown as Tables["sends"][]
      )[0];
      if (row) return row;
      selection.validate();
      mentions.validate();
      db
        .prepare(
          "INSERT INTO sends (`agent`,`request`,`input`,`result`) VALUES (?,?,?,?) RETURNING *",
        )
        .get(agent, args.request_id, input, null) as unknown as Tables["sends"];
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
      replySequence = this.store.transaction((db) => {
        const row = db
          .prepare(
            "SELECT sequence FROM reply_sequences WHERE account=? AND native=?",
          )
          .get(
            scope.account_id,
            reply.native_message_id,
          ) as unknown as Tables["reply_sequences"];
        const start = row?.sequence ?? 0;
        db.prepare(
          "INSERT INTO reply_sequences(account,native,sequence) VALUES(?,?,?) ON CONFLICT(account,native) DO UPDATE SET sequence=excluded.sequence",
        ).run(
          scope.account_id,
          reply.native_message_id,
          start + args.content.length,
        );
        return start;
      });
    }

    for (const [index, part] of content.entries()) {
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
        const category = !submitted
          ? "not_submitted"
          : rejected
            ? "platform_rejected"
            : "submission_unresolved";
        if (
          this.config.accounts.find((a) => a.id === scope.account_id)
            ?.platform === "qq"
        ) {
          const native = Array.isArray(err.errors) ? err.errors[0] : err;
          const status = native?.response?.status ?? native?.httpStatus;
          const code = native?.response?.data?.code;
          console.warn(
            JSON.stringify({
              event: "qq_send_failure",
              stage: submitted ? "native_handoff" : "before_dispatch",
              category,
              http_status:
                Number.isInteger(status) && status >= 400 && status <= 599
                  ? status
                  : null,
              native_code: Number.isSafeInteger(code) ? code : null,
            }),
          );
        }
        parts.push({
          index,
          status: !submitted || rejected ? "failed" : "unknown",
          native_message_ids: ids,
          stored: false,
          error: category,
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
        this.store.db
          .prepare(
            "UPDATE sends SET `result` = ? WHERE `agent` = ? AND `request` = ?",
          )
          .run(
            JSON.stringify({
              request_id: args.request_id,
              status: "unknown",
              parts,
              stored: false,
            }),
            agent,
            args.request_id,
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
      this.store.db
        .prepare(
          "UPDATE sends SET `result` = ? WHERE `agent` = ? AND `request` = ?",
        )
        .run(JSON.stringify(result), agent, args.request_id);
    } catch {}
    return result;
  }
  async dispatch(binding: Binding) {
    const row = (
      this.store.db
        .prepare(
          "SELECT * FROM deliveries WHERE `binding` = ? AND `state` IN (?,?) ORDER BY `seq` ASC LIMIT ?",
        )
        .all(
          binding.id,
          ...["pending", "held"],
          1,
        ) as unknown as Tables["deliveries"][]
    )[0];
    if (!row || row.due > Date.now()) return;
    const m = await this.message(row.message);
    const started = Date.now();
    let httpStatus: number | null = null;
    const diagnostic = (
      category:
        | "accepted"
        | "http_rejected"
        | "unavailable"
        | "cancelled"
        | "scope_revoked"
        | "receiver_changed",
    ) => {
      if (m?.platform === "qq")
        qqInbound({
          stage: "receiver",
          type: m.conversation.type,
          category,
          http_status: httpStatus,
          attempt: row.attempt + 1,
          elapsed_ms: Math.max(0, Date.now() - started),
        });
    };
    const update = (value: any) =>
      this.store.db
        .prepare(
          "UPDATE deliveries SET state=?, category=?, attempt=?, due=? WHERE id=?",
        )
        .run(
          value.state,
          value.category,
          value.attempt ?? row.attempt,
          value.due ?? row.due,
          row.id,
        );
    if (
      row.agent !== binding.agent_id ||
      !this.active(binding.agent_id) ||
      !m ||
      !this.admitted(binding, m)
    ) {
      await update({ state: "cancelled", category: "scope_revoked" });
      diagnostic("scope_revoked");
      return;
    }
    const consumer = this.config.agents.find((a) => a.id === binding.agent_id)!;
    if (row.receiver !== consumer.receiver_url) {
      await update({ state: "held", category: "receiver_changed" });
      diagnostic("receiver_changed");
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
        consumer.receiver_credential,
        consumer.id,
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
      httpStatus = response.status;
      await response.body?.cancel();
      if (!response.ok) throw new Error();
      await update({ state: "accepted", category: null });
      diagnostic("accepted");
    } catch (e) {
      if (e instanceof Fault && e.code === "not_found") {
        await update({ state: "cancelled", category: "scope_revoked" });
        diagnostic("scope_revoked");
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
      diagnostic(
        this.closed
          ? "cancelled"
          : httpStatus !== null && (httpStatus < 200 || httpStatus >= 300)
            ? "http_rejected"
            : "unavailable",
      );
    }
  }
  async startDispatch() {
    for (const row of this.store.db
      .prepare("SELECT * FROM deliveries WHERE `state` IN (?,?)")
      .all(...["pending", "held"]) as unknown as Tables["deliveries"][])
      if (!this.config.bindings.some((b) => b.id === row.binding))
        this.store.db
          .prepare(
            "UPDATE deliveries SET `state` = ?,`category` = ? WHERE `id` = ?",
          )
          .run("cancelled", "binding_removed", row.id);

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
  private lastHealthDiagnostic = "";
  async status(forceDiagnostic = false) {
    const backlog = [];
    for (const state of ["pending", "held", "accepted", "cancelled"]) {
      const count = (
        this.store.db
          .prepare("SELECT count(*) AS n FROM deliveries WHERE `state` = ?")
          .get(state) as unknown as { n: number }
      ).n;
      if (count) backlog.push({ state, count });
    }
    let full = false;
    for (const b of this.config.bindings)
      if (
        (
          this.store.db
            .prepare(
              "SELECT count(*) AS n FROM deliveries WHERE `binding` = ? AND `state` IN (?,?)",
            )
            .get(b.id, ...["pending", "held"]) as unknown as { n: number }
        ).n >= this.config.backlog_limit
      )
        full = true;
    const result = {
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
    const platforms = [...this.platforms.values()];
    const snapshot = JSON.stringify({
      event: "post_readiness",
      category: result.healthy
        ? "healthy"
        : this.closed
          ? "stopped"
          : "degraded",
      qq_total: platforms.filter((p) => p.config.platform === "qq").length,
      qq_ready: platforms.filter((p) => p.config.platform === "qq" && p.ready)
        .length,
      matrix_total: platforms.filter((p) => p.config.platform === "matrix")
        .length,
      matrix_ready: platforms.filter(
        (p) => p.config.platform === "matrix" && p.ready,
      ).length,
      pending: backlog.find((r) => r.state === "pending")?.count ?? 0,
      held: backlog.find((r) => r.state === "held")?.count ?? 0,
      backlog_full: full ? 1 : 0,
      capture_errors: [...this.errors.values()].filter((e) =>
        e.startsWith("capture_"),
      ).length,
      dispatch_errors: [...this.errors.values()].filter(
        (e) => e === "dispatch_storage",
      ).length,
      other_errors: [...this.errors.values()].filter(
        (e) => !e.startsWith("capture_") && e !== "dispatch_storage",
      ).length,
    });
    if (forceDiagnostic || snapshot !== this.lastHealthDiagnostic) {
      this.lastHealthDiagnostic = snapshot;
      console.warn(snapshot);
    }
    return result;
  }
  async stop() {
    if (this.closed) return;
    this.closed = true;
    this.stopSignal.abort();
    await Promise.allSettled([...this.platforms.values()].map((p) => p.stop()));
    await Promise.allSettled([...this.jobs]);
  }
}
