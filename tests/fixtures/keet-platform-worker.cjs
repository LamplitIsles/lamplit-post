const RPC = require("tiny-buffer-rpc");
const codec = require("tiny-buffer-rpc/any.js");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const z32 = require("z32");
const crypto = require("node:crypto");
const identity = process.argv[2];
const file = path.join(identity, "fixture.json");
if (fs.existsSync(path.join(identity, "trace-workers"))) {
  const trace = path.join(identity, "worker-events");
  fs.appendFileSync(trace, `start ${process.pid}\n`);
  process.on("exit", () => fs.appendFileSync(trace, `exit ${process.pid}\n`));
}
const state = () => JSON.parse(fs.readFileSync(file, "utf8"));
const save = (value) => {
  const temp = file + ".worker";
  fs.writeFileSync(temp, JSON.stringify(value));
  fs.renameSync(temp, file);
};
const ipc = new net.Socket({ fd: 3, readable: true, writable: true });
const rpc = new RPC((message) => {
  const frame = Buffer.alloc(message.length + 4);
  frame.writeUInt32LE(message.length);
  message.copy(frame, 4);
  ipc.write(frame);
});
const call = (id) => async (args) => {
  const s = state();
  if (s.fail === id) throw new Error("private worker error");
  if (id === 1)
    return {
      modules: { "keet-core": "4.26.4" },
      buildType: "Production",
      abi: { min: 40, max: 40, autoupgrade: 37 },
    };
  if (id === 6)
    return {
      memberId: s.member,
      displayName: s.displayName,
      avatar: s.avatar
        ? Object.fromEntries(Object.entries(s.avatar).map(([size, item]) => [
            size,
            {
              ...item,
              hash: Buffer.from(item.hash.data),
              pointer: { inlined: Buffer.from(item.pointer.inlined.data).toString("base64") },
            },
          ]))
        : null,
    };
  if (id === 19) {
    s.displayName = args[0].displayName;
    if (args[0].avatar) s.avatar = args[0].avatar;
    save(s);
    return null;
  }
  if (id === 43)
    return { rooms: Object.keys(s.rooms).map((roomId) => ({ roomId })) };
  if (id === 39) {
    const room = s.rooms[args[0]];
    if (!room) return null;
    return {
      roomId: args[0],
      status: {
        isReadable: room.readable,
        isWritable: room.malformed ? null : room.writable,
        isRemoved: room.removed,
      },
      config: { roomType: room.type, title: room.name },
      dmMemberId: room.peer || null,
      ...(room.missingSelf === "no-self"
        ? {}
        : {
            self: room.missingSelf
              ? room.missingSelf === "absent"
                ? {}
                : { member: null }
              : {
                  member: {
                    memberId: s.member,
                    status: {
                      isActive: !room.removed,
                      isRemoved: room.removed,
                      isPending: false,
                      isBanned: false,
                    },
                  },
                },
          }),
    };
  }
  if (id === 66)
    return [
      { memberId: s.member, displayName: "Self", status: { isActive: true } },
      { memberId: "peer", displayName: "Peer", status: { isActive: true } },
    ];
  if (id === 158 || id === 163)
    return (s.invites || [])
      .filter((i) => i.kind === (id === 158 ? "direct" : "group"))
      .map((i) => ({
        id: { memberId: i.peer, roomId: i.room },
        senderContactInfo: { memberId: i.peer, displayName: i.name },
        ...(i.kind === "group" ? { name: i.name } : {}),
      }));
  if (id === 160 || id === 165) {
    const invite = s.invites.find(
      (i) => i.room === args[0].roomId && i.peer === args[0].memberId,
    );
    if (!invite) throw new Error("stale");
    s.invites = s.invites.filter((i) => i !== invite);
    if (s.autoJoin)
      s.rooms[invite.room] = {
        type: id === 160 ? "2" : "0",
        readable: true,
        writable: true,
        removed: false,
        peer: invite.peer,
        name: invite.name,
      };
    save(s);
    return null;
  }
  if (id === 185)
    return {
      hash: crypto.createHash("sha256").update(args[1]).digest(),
      metadata: args[2],
      pointer: { inlined: args[1] },
    };
  if (id === 105) {
    const key = Buffer.alloc(32, 8),
      seq = (s.sequence || 0) + 1,
      options = args[2] || {};
    s.sequence = seq + (options.files?.[0]?.preview ? 1 : 0);
    const message = {
      id: { deviceId: z32.encode(key), seq },
      memberId: s.member,
      chat:
        args[1] === null
          ? null
          : { text: args[1], mentions: options.mentions || [] },
      files: options.files || [],
      replyTo: options.replyTo || null,
      timestamp: Date.now(),
    };
    s.sent = [...(s.sent || []), message];
    save(s);
    if (s.dropSend) return new Promise(() => {});
    return { key, length: s.sequence + 1 };
  }
  if (id === 141) {
    const m = (s.sent || []).find(
      (m) => m.id.deviceId === args[1].deviceId && m.id.seq === args[1].seq,
    );
    if (m)
      for (const f of m.files)
        if (f.hash?.type === "Buffer") f.hash = Buffer.from(f.hash.data);
    return m || null;
  }
  if (id === 22) {
    const link = s.links[args[0]];
    return link
      ? {
          isRoomInvitation: true,
          invitationSeed: link.seed,
          roomId: link.room || null,
          title: link.name || null,
        }
      : null;
  }
  if (id === 28) {
    const link = s.links[args[0]];
    s.joins = (s.joins || 0) + 1;
    if (link.joinedRoom) {
      link.room = link.joinedRoom;
      s.rooms[link.room] = {
        type: "0",
        readable: true,
        writable: true,
        removed: false,
        name: link.name,
      };
    }
    if (link.unrelatedRoom)
      s.rooms[link.unrelatedRoom] = {
        type: "0",
        readable: true,
        writable: true,
        removed: false,
        name: "Unrelated",
      };
    save(s);
    return { seedId: link.seed, key: link.room || null };
  }
  return null;
};
for (const id of [
  0, 1, 6, 19, 22, 25, 28, 39, 43, 66, 105, 141, 142, 158, 160, 163, 165, 185,
  243,
])
  rpc.register(id, { request: codec, response: codec, onrequest: call(id) });
rpc.register(145, {
  request: codec,
  response: codec,
  onstream: (stream) => {
    stream.on("error", () => {});
    stream.once("data", (args) => {
      let last = "";
      const push = () => {
        const items = (state().history || {})[args[0]] || [];
        const encoded = JSON.stringify(items);
        if (encoded !== last) {
          last = encoded;
          stream.write(items);
        }
      };
      push();
      const timer = setInterval(push, 50);
      stream.once("close", () => clearInterval(timer));
    });
  },
});
let input = Buffer.alloc(0);
ipc.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4 && input.length >= input.readUInt32LE() + 4) {
    const n = input.readUInt32LE();
    rpc.recv(input.subarray(4, 4 + n));
    input = input.subarray(4 + n);
  }
});
ipc.on("error", () => {});
ipc.on("end", () => {
  rpc.destroy();
  ipc.destroy();
});
console.log("Keet core worker started");

rpc.register(199, {
  request: codec,
  response: codec,
  onstream: (stream) => {
    stream.on("error", () => {});
    stream.once("data", (args) => {
      const value = args[1].pointer.inlined;
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value.data);
      stream.end(bytes);
    });
  },
});
