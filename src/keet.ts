import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import sharp from "sharp";
import z32 from "z32";
import type { AccountConfig, Scope } from "./config";
import type { Observation, Platform } from "./platform";
import type { ContentV1, MessageV1 } from "../contracts/v1/index";
import type { Service } from "./service";
import { KeetSidecar, type RuntimeHashes } from "./keet-sidecar";
import { Fault, need, UnconfirmedKeetMembership } from "./errors";
import { isSqliteError } from "./store";

const bounded = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 256;
function decodeCanonicalBase64(
  value: unknown,
  encodedLimit: number,
  decodedLimit: number,
): Buffer | null {
  if (typeof value !== "string" || !value.length || value.length > encodedLimit)
    return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.length > 0 &&
    bytes.length <= decodedLimit &&
    bytes.toString("base64") === value
    ? bytes
    : null;
}
const nativeId = (v: any): string | undefined =>
  bounded(v?.deviceId) && Number.isSafeInteger(v.seq) && v.seq >= 0
    ? JSON.stringify([v.deviceId, v.seq])
    : undefined;
const parseNativeId = (v: string) => {
  try {
    const [deviceId, seq] = JSON.parse(v);
    if (bounded(deviceId) && Number.isSafeInteger(seq) && seq >= 0)
      return { deviceId, seq };
  } catch {}
  throw new Fault("invalid_request");
};
interface Room {
  native_id: string;
  type: "direct" | "group";
  name?: string;
  writable: boolean;
  peer?: string;
}
interface Invite {
  kind: "direct" | "group";
  room_id: string;
  peer_id: string;
  name: string | null;
}

export class KeetPlatform implements Platform {
  readonly sidecar: KeetSidecar;
  nativeUserId = "";
  private started = false;
  get ready() {
    return this.started && this.sidecar.active;
  }
  set ready(value: boolean) {
    this.started = value;
  }
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private watches = new Map<string, { stream: Duplex; task: Promise<void> }>();
  private poll?: Promise<void>;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  constructor(
    public config: AccountConfig,
    private service: Service,
    fixture?: { hashes?: RuntimeHashes; swarming: false },
    private readonly ownerSignal?: AbortSignal,
  ) {
    this.sidecar = new KeetSidecar(
      service.config.keet_runtime_dir!,
      config.identity_dir!,
      service.config.timeout_ms,
      fixture?.swarming ?? true,
      fixture?.hashes,
    );
  }
  private async rpc(
    id: number,
    args: unknown[],
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<any> {
    try {
      return await this.sidecar.call(id, args, signal, onDispatch);
    } catch {
      if (!this.sidecar.active) this.ready = false;
      throw new Fault("unavailable");
    }
  }
  start() {
    return (this.starting ??= this.initialize());
  }
  private async initialize() {
    const identities = this.service.store.db
      .prepare(
        "SELECT account,platform,native FROM identities WHERE account=? OR (platform=? AND native=?)",
      )
      .all(this.config.id, "keet", this.config.native_id);
    for (const identity of identities)
      need(
        identity.account === this.config.id &&
          identity.platform === "keet" &&
          identity.native === this.config.native_id,
        "conflict",
      );
    this.ownerSignal?.throwIfAborted();
    await this.sidecar.start();
    const identity: any = await this.sidecar.call(
      6,
      [],
      this.service.signal(this.ownerSignal),
    );
    need(bounded(identity?.memberId), "unavailable");
    need(identity.memberId === this.config.native_id, "conflict");
    this.nativeUserId = identity.memberId;
    await this.service.store.pin(this.config.id, "keet", identity.memberId);
    need(!this.stopped && !this.service.closed, "unavailable");
    await this.sync(true);
    this.ownerSignal?.throwIfAborted();
    need(!this.stopped && !this.service.closed, "unavailable");
    this.ready = true;
    this.schedule();
  }
  private schedule() {
    if (!this.stopped && this.ready)
      this.timer = setTimeout(() => {
        this.poll = this.sync()
          .catch((error) => {
            if (isSqliteError(error)) this.service.storageFailed = true;
            if (!this.stopped)
              void this.service.store
                .gap(this.config.id, "connection_gap")
                .catch((e) => {
                  if (isSqliteError(e)) this.service.storageFailed = true;
                });
          })
          .finally(() => this.schedule());
      }, 2000);
  }
  stop() {
    return (this.stopping ??= this.retire());
  }
  private async retire() {
    this.stopped = true;
    this.ready = false;
    if (this.timer) clearTimeout(this.timer);
    for (const watch of this.watches.values()) watch.stream.destroy();
    await this.sidecar.stop();
    await this.starting?.catch(() => {});
    await this.poll?.catch(() => {});
    await Promise.allSettled([...this.watches.values()].map((w) => w.task));
    this.watches.clear();
  }
  private async pending(
    kind: "direct" | "group",
    signal: AbortSignal,
    strict = false,
  ): Promise<Invite[]> {
    const raw = await this.rpc(
      kind === "direct" ? 158 : 163,
      [3, { reverse: true, limit: 512 }],
      signal,
    );
    need(Array.isArray(raw) && raw.length < 512, "unavailable");
    return raw.flatMap((item: any) => {
      const peer_id = item?.id?.memberId ?? item?.senderContactInfo?.memberId;
      const room_id = item?.id?.roomId ?? item?.roomId;
      if (!bounded(peer_id) || !bounded(room_id)) {
        need(!strict, "unavailable");
        return [];
      }
      const name =
        kind === "group" ? item?.name : item?.senderContactInfo?.displayName;
      return [
        {
          kind,
          room_id,
          peer_id,
          name: typeof name === "string" ? name.slice(0, 256) : null,
        },
      ];
    });
  }
  async invites(signal: AbortSignal) {
    return [
      ...(await this.pending("group", signal)),
      ...(await this.pending("direct", signal)),
    ];
  }
  private async room(id: string, signal: AbortSignal): Promise<Room> {
    need(bounded(id), "not_found");
    const info = await this.rpc(39, [id], signal);
    need(info, "not_found");
    need(info.roomId === id && info.status && info.config, "unavailable");
    need(
      typeof info.status.isReadable === "boolean" &&
        typeof info.status.isRemoved === "boolean",
      "unavailable",
    );
    need(info.status.isReadable && !info.status.isRemoved);
    need(typeof info.status.isWritable === "boolean", "unavailable");
    const kind = info.config.roomType;
    need(kind === "0" || kind === "1" || kind === "2", "unavailable");
    const type = kind === "2" ? "direct" : "group";
    if (type === "direct")
      need(
        bounded(info.dmMemberId) && info.dmMemberId !== this.nativeUserId,
        "unavailable",
      );
    need(
      info.self !== null &&
        typeof info.self === "object" &&
        !Array.isArray(info.self),
      "unavailable",
    );
    if (info.self.member == null) throw new UnconfirmedKeetMembership();
    const self = info.self.member;
    need(
      self.memberId === this.nativeUserId &&
        self.status &&
        typeof self.status.isActive === "boolean" &&
        typeof self.status.isRemoved === "boolean" &&
        typeof self.status.isPending === "boolean" &&
        typeof self.status.isBanned === "boolean",
      "unavailable",
    );
    need(
      self.status.isActive === true &&
        self.status.isRemoved === false &&
        self.status.isPending === false &&
        self.status.isBanned === false,
    );
    let peer: string | undefined;
    if (type === "direct") {
      peer = info.dmMemberId;
      const pending = await this.pending("direct", signal, true);
      need(!pending.some((i) => i.peer_id === peer || i.room_id === id));
    }
    return {
      native_id: id,
      type,
      writable: info.status.isWritable === true,
      ...(peer ? { peer } : {}),
      ...(typeof info.config.title === "string" && info.config.title.trim()
        ? { name: info.config.title.trim().slice(0, 256) }
        : {}),
    };
  }
  async directory(signal: AbortSignal) {
    const raw = await this.rpc(43, [{ limit: 512 }], signal);
    need(
      Array.isArray(raw?.rooms) &&
        raw.rooms.length < 512 &&
        (raw.total === undefined || raw.total <= 512),
      "unavailable",
    );
    const result: Room[] = [];
    for (const item of raw.rooms) {
      if (!bounded(item?.roomId)) continue;
      try {
        result.push(await this.room(item.roomId, signal));
      } catch (e) {
        if (
          !(e instanceof UnconfirmedKeetMembership) &&
          !(e instanceof Fault && e.code === "not_found")
        )
          throw e;
      }
    }
    return result;
  }
  async check(scope: Scope, signal: AbortSignal) {
    const room = await this.room(scope.native_id, signal);
    need(room.type === scope.type);
    this.checkPeerHistory(room);
  }
  async checkObservation(o: Observation, signal: AbortSignal) {
    const room = await this.room(o.conversation_native_id, signal);
    need(
      room.type === o.conversation_type &&
        (room.type !== "direct" || room.peer === o.sender),
    );
    this.checkPeerHistory(room);
  }
  private checkPeerHistory(room: Room) {
    if (room.type !== "direct") return;
    need(room.peer);
    const stale = this.service.store.db
      .prepare(
        "SELECT 1 FROM messages m JOIN conversations c ON c.id=m.conversation AND c.account=m.account WHERE c.account=? AND c.native=? AND c.type='direct' AND m.sender<>? AND m.sender<>? LIMIT 1",
      )
      .get(this.config.id, room.native_id, this.nativeUserId, room.peer);
    need(!stale);
  }
  async members(scope: Scope, signal: AbortSignal) {
    await this.check(scope, signal);
    const raw = await this.rpc(66, [scope.native_id, { limit: 512 }], signal);
    need(Array.isArray(raw) && raw.length < 512, "unavailable");
    return {
      items: raw.flatMap((m: any) =>
        bounded(m?.memberId) && m.status?.isActive === true
          ? [
              {
                native_id: m.memberId,
                ...(typeof m.displayName === "string"
                  ? { name: m.displayName.slice(0, 256) }
                  : {}),
              },
            ]
          : [],
      ),
      capability: "supported" as const,
    };
  }
  private async sync(initializing = false) {
    const rooms = await this.service.refreshKeet(
      this.config.id,
      this.service.signal(this.ownerSignal),
      initializing ? this : undefined,
    );
    this.ownerSignal?.throwIfAborted();
    need(!this.stopped && !this.service.closed, "unavailable");
    const ids = new Set(rooms.map((r) => r.native_id));
    for (const [id, watch] of this.watches)
      if (!ids.has(id)) watch.stream.destroy();
    for (const room of rooms)
      if (!this.watches.has(room.native_id)) this.watch(room);
  }
  private watch(room: Room) {
    const stream = this.sidecar.stream(145, [
      room.native_id,
      { limit: 50, reverse: true },
    ]);
    const seen = new Map<string, string>();
    const task = (async () => {
      let first = true;
      try {
        for await (const frame of stream) {
          if (!Array.isArray(frame)) throw new Error("invalid frame");
          const initial = first;
          first = false;
          for (const record of frame) {
            const id = nativeId(record?.id);
            if (!id) continue;
            const mutation = record.deleted
              ? "retraction"
              : record.chat?.edited
                ? "edit"
                : undefined;
            const mutationId = mutation
              ? createHash("sha256")
                  .update(
                    JSON.stringify([mutation, record.editedAt, record.chat]),
                  )
                  .digest("hex")
              : "";
            if (seen.has(id) && (!mutation || seen.get(id) === mutationId))
              continue;
            seen.set(id, mutationId);
            if (seen.size > 1024) seen.delete(seen.keys().next().value!);
            if (!initial)
              await this.capture(room, record, id, mutation, mutationId);
          }
        }
      } catch (error) {
        if (isSqliteError(error)) this.service.storageFailed = true;
        if (!this.stopped)
          await this.service.store
            .gap(this.config.id, "connection_gap")
            .catch((e) => {
              if (isSqliteError(e)) this.service.storageFailed = true;
            });
      } finally {
        this.watches.delete(room.native_id);
      }
    })();
    this.watches.set(room.native_id, { stream, task });
  }
  private async capture(
    room: Room,
    record: any,
    id: string,
    mutation?: "edit" | "retraction",
    mutationId?: string,
  ) {
    if (
      this.stopped ||
      this.service.closed ||
      record.event ||
      !bounded(record.memberId) ||
      record.memberId === this.nativeUserId ||
      !Number.isSafeInteger(record.timestamp)
    )
      return;
    const text = mutation === "retraction" ? null : record.chat?.text;
    if (text != null && (typeof text !== "string" || text.length > 16384))
      return;
    const mentions =
      mutation !== "retraction" && Array.isArray(record.chat?.mentions)
        ? record.chat.mentions
        : [];
    if (
      mentions.some(
        (m: any) =>
          !bounded(m.memberId) ||
          !Number.isInteger(m.start) ||
          !Number.isInteger(m.length) ||
          m.start < 0 ||
          m.length <= 0 ||
          m.start + m.length > (text?.length ?? 0),
      )
    )
      return;
    const sorted = [...mentions].sort((a: any, b: any) => a.start - b.start);
    const content: ContentV1[] = [];
    let offset = 0;
    for (const m of sorted) {
      if (m.start < offset) return;
      if (m.start > offset)
        content.push({ type: "text", text: text.slice(offset, m.start) });
      content.push({ type: "mention", native_user_id: m.memberId });
      offset = m.start + m.length;
    }
    if (text && offset < text.length)
      content.push({ type: "text", text: text.slice(offset) });
    const assets: MessageV1["assets"] = [];
    const files =
      mutation !== "retraction" && Array.isArray(record.files)
        ? record.files
        : [];
    if (files.length > 32) return;
    for (const file of files) {
      const mime =
        typeof file?.metadata?.mimetype === "string" &&
        /^[\w.+-]{1,127}\/[\w.+-]{1,127}$/.test(file.metadata.mimetype)
          ? file.metadata.mimetype
          : "application/octet-stream";
      const name =
        typeof file?.metadata?.name === "string"
          ? file.metadata.name.replace(/[\x00-\x1f/\\]/g, "_").slice(0, 255)
          : "attachment";
      let asset;
      try {
        const bytes = await this.readFile(
          room.native_id,
          file,
          this.service.signal(),
        );
        asset = await this.service.assets.ingest(
          new ReadableStream({
            start(c) {
              c.enqueue(bytes);
              c.close();
            },
          }),
          mime,
          name,
          null,
          this.service.signal(),
        );
      } catch {
        asset = await this.service.assets.unavailable(
          mime,
          name,
          "download_unavailable",
        );
      }
      assets.push(asset);
      content.push({
        type: mime.startsWith("image/") ? "image" : "file",
        asset_id: asset.asset_id,
      });
    }
    if (!content.length && mutation !== "retraction") return;
    const observation: Observation = {
      native_id: id,
      conversation_native_id: room.native_id,
      conversation_type: room.type,
      sender: record.memberId,
      name:
        typeof record.member?.displayName === "string"
          ? record.member.displayName.slice(0, 256)
          : undefined,
      conversation_name: room.name,
      timestamp: record.timestamp,
      content,
      assets,
      mentions: sorted.map((m: any) => m.memberId),
      self_mentioned: sorted.some((m: any) => m.memberId === this.nativeUserId),
      reply_native_id: nativeId(record.replyTo),
      mutation,
      mutation_id: mutationId,
      catchup: false,
    };
    await this.service.observe(this.config.id, observation);
  }
  private async readFile(room: string, file: any, signal: AbortSignal) {
    signal.throwIfAborted();
    const stream = this.sidecar.stream(
      199,
      [room, file, { includeProgress: false }],
      true,
    );
    const abort = () => stream.destroy();
    signal.addEventListener("abort", abort, { once: true });
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of stream) {
        signal.throwIfAborted();
        need(
          Buffer.isBuffer(chunk) || chunk instanceof Uint8Array,
          "unavailable",
        );
        length += chunk.length;
        need(length <= this.service.config.max_asset_bytes, "capacity");
        chunks.push(Buffer.from(chunk));
      }
      signal.throwIfAborted();
      need(length > 0, "unavailable");
      return Buffer.concat(chunks);
    } finally {
      signal.removeEventListener("abort", abort);
      stream.destroy();
    }
  }
  async preflight(
    scope: Scope,
    content: ContentV1[],
    reply: MessageV1 | null,
    signal: AbortSignal,
  ) {
    const room = await this.room(scope.native_id, signal);
    need(room.type === scope.type && room.writable, "invalid_request");
    if (reply) {
      const id = parseNativeId(reply.native_message_id);
      const raw = await this.rpc(141, [scope.native_id, id], signal);
      need(nativeId(raw?.id) === reply.native_message_id, "invalid_request");
    }
    if (content.some((part) => part.type === "mention")) {
      const members = await this.members(scope, signal);
      for (const part of content)
        if (part.type === "mention")
          need(
            members.items.some((m) => m.native_id === part.native_user_id),
            "invalid_request",
          );
    }
    for (const part of content)
      if (part.type === "image") {
        const bytes = await this.service.assets.bytes(part.asset_id, signal);
        await imageVariants(bytes);
      }
  }
  async send(
    scope: Scope,
    part: ContentV1,
    reply: MessageV1 | null,
    signal: AbortSignal,
    _sequence?: number,
    onDispatch = () => {},
  ) {
    const room = await this.room(scope.native_id, signal);
    need(room.type === scope.type && room.writable, "invalid_request");
    let text: string | null = null;
    const options: any = {};
    let expectedHash: Buffer | undefined;
    let preview = false;
    if (reply) options.replyTo = parseNativeId(reply.native_message_id);
    if (part.type === "text") text = part.text;
    else if (part.type === "mention") {
      const members = await this.members(scope, signal);
      const member = members.items.find(
        (m) => m.native_id === part.native_user_id,
      );
      need(member, "invalid_request");
      text = "@" + (member.name || member.native_id);
      options.mentions = [
        { memberId: member.native_id, start: 0, length: text.length },
      ];
    } else {
      const metadata = await this.service.assets.metadata(part.asset_id);
      const bytes = await this.service.assets.bytes(part.asset_id, signal);
      let dimensions;
      if (part.type === "image") {
        const info = await sharp(bytes, {
          limitInputPixels: 20_000_000,
          failOn: "error",
        }).metadata();
        need(info.width && info.height, "invalid_request");
        dimensions = { width: info.width, height: info.height };
      }
      const saved = await this.rpc(
        185,
        [
          scope.native_id,
          bytes,
          {
            mimetype: metadata.mime,
            name: metadata.name,
            ...(dimensions ? { dimensions } : {}),
          },
        ],
        signal,
      );
      need(saved && saved.pointer && saved.metadata, "unavailable");
      expectedHash = createHash("sha256").update(bytes).digest();
      if (part.type === "image") {
        saved.preview = await imageVariants(bytes);
        preview = true;
      }
      options.files = [saved];
    }
    const current = await this.room(scope.native_id, signal);
    need(current.type === scope.type && current.writable, "invalid_request");
    this.checkPeerHistory(current);
    signal.throwIfAborted();
    const receipt = await this.rpc(
      105,
      [scope.native_id, text, options],
      signal,
      onDispatch,
    );
    need(
      (Buffer.isBuffer(receipt?.key) || receipt?.key instanceof Uint8Array) &&
        receipt.key.length === 32 &&
        Number.isSafeInteger(receipt.length),
      "unavailable",
    );
    const seq = receipt.length - (preview ? 2 : 1);
    need(seq >= 0, "unavailable");
    const candidate = { deviceId: z32.encode(receipt.key), seq };
    const observed = await this.rpc(141, [scope.native_id, candidate], signal);
    need(nativeId(observed?.id) === nativeId(candidate), "unavailable");
    if (text !== null) need(observed?.chat?.text === text, "unavailable");
    if (part.type === "mention")
      need(
        observed?.chat?.mentions?.some(
          (m: any) =>
            m.memberId === part.native_user_id &&
            m.start === 0 &&
            m.length === text!.length,
        ),
        "unavailable",
      );
    if (expectedHash) {
      need(
        Array.isArray(observed?.files) && observed.files.length === 1,
        "unavailable",
      );
      const bytes = await this.readFile(
        scope.native_id,
        observed.files[0],
        signal,
      );
      need(
        createHash("sha256").update(bytes).digest().equals(expectedHash),
        "unavailable",
      );
    }
    if (reply)
      need(
        nativeId(observed?.replyTo) === reply.native_message_id,
        "unavailable",
      );
    return [nativeId(candidate)!];
  }
  async profile(signal: AbortSignal) {
    const identity = await this.rpc(6, [], signal);
    need(identity?.memberId === this.nativeUserId, "unavailable");
    const name =
      typeof identity.displayName === "string"
        ? identity.displayName.slice(0, 128)
        : null;
    const avatar = identity.avatar?.large;
    const value = avatar?.pointer?.inlined;
    const mime = avatar?.metadata?.mimetype;
    const bytes = decodeCanonicalBase64(value, 700000, 525000);
    if (bytes && ["image/png", "image/jpeg", "image/webp"].includes(mime)) {
      try {
        await this.service.assets.validateImage(mime, bytes);
        return { display_name: name, avatar: { mime, data_base64: value } };
      } catch {
        /* Invalid native media cannot be returned as an avatar. */
      }
    }
    return { display_name: name, avatar: null };
  }
  async saveProfile(
    input: {
      display_name?: string;
      avatar?: { mime: string; data_base64: string };
    },
    signal: AbortSignal,
  ) {
    need(
      input.display_name !== undefined || input.avatar !== undefined,
      "invalid_request",
    );
    if (input.display_name !== undefined)
      need(
        typeof input.display_name === "string" &&
          input.display_name.trim().length > 0 &&
          input.display_name.length <= 128,
        "invalid_request",
      );
    let avatar;
    if (input.avatar !== undefined) {
      need(
        input.avatar &&
          Object.keys(input.avatar).every(
            (key) => key === "mime" || key === "data_base64",
          ) &&
          ["image/png", "image/jpeg", "image/webp"].includes(
            input.avatar?.mime,
          ),
        "invalid_request",
      );
      const bytes = decodeCanonicalBase64(
        input.avatar.data_base64,
        11_184_812,
        8 * 1024 * 1024,
      );
      need(bytes, "invalid_request");
      await this.service.assets.validateImage(input.avatar.mime, bytes);
      avatar = await imageVariants(bytes);
    }
    const current = await this.rpc(6, [], signal);
    need(current?.memberId === this.nativeUserId, "unavailable");
    const displayName = input.display_name?.trim() ?? current.displayName;
    need(
      typeof displayName === "string" && displayName.length > 0,
      "invalid_request",
    );
    if (!avatar && current.avatar) {
      const preserved: Record<string, unknown> = {};
      for (const name of ["small", "medium", "large"]) {
        const item = current.avatar[name];
        const data = item?.pointer?.inlined;
        need(
          typeof data === "string" &&
            data.length <= 700000 &&
            (Buffer.isBuffer(item.hash) || item.hash instanceof Uint8Array),
          "unavailable",
        );
        const bytes = Buffer.from(data, "base64");
        need(
          bytes.length > 0 &&
            createHash("sha256")
              .update(bytes)
              .digest()
              .equals(Buffer.from(item.hash)),
          "unavailable",
        );
        preserved[name] = {
          hash: item.hash,
          metadata: item.metadata,
          pointer: { inlined: bytes },
        };
      }
      avatar = preserved;
    }
    await this.rpc(
      19,
      [{ displayName, ...(avatar ? { avatar } : {}) }],
      signal,
    );
    return this.profile(signal);
  }
  private async inspectNative(link: string, signal: AbortSignal) {
    need(
      typeof link === "string" &&
        link.length <= 8192 &&
        /^keet:\/\/chat\/[A-Za-z0-9._~%!$&'()*+,;=:@/?-]+$/.test(link),
      "invalid_request",
    );
    const raw = await this.rpc(22, [link.slice("keet://chat/".length)], signal);
    need(
      raw?.isRoomInvitation === true && bounded(raw.invitationSeed),
      "invalid_request",
    );
    const target_id = createHash("sha256")
      .update(raw.invitationSeed)
      .digest("hex");
    let room_id: string | null = null;
    if (bounded(raw.roomId)) {
      try {
        const room = await this.room(raw.roomId, signal);
        need(room.type === "group", "unavailable");
        room_id = raw.roomId;
      } catch (e) {
        if (!(e instanceof Fault && e.code === "not_found")) throw e;
      }
    }
    return {
      target_id,
      name: typeof raw.title === "string" ? raw.title.slice(0, 256) : null,
      room_id,
    };
  }
  inspectLink(link: string, signal: AbortSignal) {
    return this.inspectNative(link, signal);
  }
  async joinLink(link: string, target: string, signal: AbortSignal) {
    const before = await this.inspectNative(link, signal);
    need(before.target_id === target, "conflict");
    if (before.room_id) return { status: "joined" as const };
    let result;
    try {
      result = await this.rpc(28, [link.slice("keet://chat/".length)], signal);
    } catch {
      return { status: "unknown" as const };
    }
    if (
      !bounded(result?.seedId) ||
      createHash("sha256").update(result.seedId).digest("hex") !== target
    )
      return { status: "unknown" as const };
    try {
      const after = await this.inspectNative(link, signal);
      return {
        status:
          after.target_id === target && after.room_id
            ? ("joined" as const)
            : ("pending" as const),
      };
    } catch {
      return { status: "unknown" as const };
    }
  }
  async acceptInvite(
    kind: "direct" | "group",
    room: string,
    peer: string,
    signal: AbortSignal,
  ) {
    const pending = await this.pending(kind, signal);
    need(
      pending.filter((i) => i.room_id === room && i.peer_id === peer).length ===
        1,
      "conflict",
    );
    try {
      await this.rpc(
        kind === "direct" ? 160 : 165,
        [{ memberId: peer, roomId: room }],
        signal,
      );
    } catch {
      return { status: "unknown" as const };
    }
    try {
      const current = await this.room(room, signal);
      return {
        status:
          current.type === kind && (kind !== "direct" || current.peer === peer)
            ? ("joined" as const)
            : ("pending" as const),
      };
    } catch (e) {
      return {
        status:
          e instanceof Fault && e.code === "not_found"
            ? ("pending" as const)
            : ("unknown" as const),
      };
    }
  }
}

async function imageVariants(bytes: Buffer) {
  try {
    const image = sharp(bytes, {
      limitInputPixels: 20_000_000,
      failOn: "error",
    });
    const info = await image.metadata();
    need(
      ["png", "jpeg", "webp", "gif"].includes(info.format ?? "") &&
        info.width &&
        info.height,
      "invalid_request",
    );
    const result: Record<string, unknown> = {};
    for (const [name, size] of [
      ["small", 64],
      ["medium", 128],
      ["large", 256],
    ] as const) {
      const data = await image
        .clone()
        .rotate()
        .resize(size, size, { fit: "cover" })
        .png()
        .toBuffer();
      need(data.length <= 512 * 1024, "invalid_request");
      result[name] = {
        hash: createHash("sha256").update(data).digest(),
        metadata: {
          mimetype: "image/png",
          name: "avatar.png",
          dimensions: { width: size, height: size },
        },
        pointer: { inlined: data },
      };
    }
    return result;
  } catch {
    throw new Fault("invalid_request");
  }
}
