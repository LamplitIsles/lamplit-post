import { count } from "./fixtures/state";
import { test, expect } from "vitest";
import { createConnection } from "node:net";
import { writeFile } from "node:fs/promises";
import { ClientEvent, RoomEvent } from "matrix-js-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { start } from "../src/runtime";
import { Store } from "../src/store";
import type { MatrixUserBot } from "../src/matrix";
import { platformsFixture } from "./fixtures/platforms";
import { stateFixture, until } from "./fixtures/state";
import { consumerFixture } from "./fixtures/consumer";
const qq = { account_id: "qq-main", conversation_id: "qq-group" };
const dm = { account_id: "qq-main", conversation_id: "qq-dm" };
async function connect(url: string, token: string) {
  const client = new Client({ name: "review-regression", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + token } },
    }),
  );
  return client;
}
async function fixture(
  timeout = 3000,
  configure?: (
    s: Awaited<ReturnType<typeof stateFixture>>,
    p: Awaited<ReturnType<typeof platformsFixture>>,
  ) => void | Promise<void>,
) {
  const p = await platformsFixture(),
    receiver = await consumerFixture(),
    s = await stateFixture(p.url, receiver.url, timeout);
  await configure?.(s, p);
  const r = await start(s.config, { qqOrigin: p.url, qqGateway: p.gateway });
  const client = await connect(r.http.url, s.token);
  return {
    p,
    receiver,
    s,
    r,
    client,
    call: (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args }),
    async close() {
      await client.close();
      await r.stop();
      await p.close();
      await receiver.close();
      await s.close();
    },
  };
}
test("QQ private peer admission protects history, assets and send while retaining authorized self history", async () => {
  let token = "";
  const f = await fixture(3000, async (s) => {
    const b = structuredClone(s.config.bindings[0]!);
    b.id = "other-binding";
    b.agent_id = "other";
    b.receiver_credential = "other-receiver";
    b.scopes = [{ ...b.scopes[1]!, senders: ["someone-else"] }, b.scopes[0]!];
    s.config.bindings.push(b);
    const store = await Store.open(s.config);
    await store.putSecret("other-receiver", b.id, "receiver", "test-receiver");
    token = await store.issue("other");
    await store.close();
  });
  let other: Client | undefined;
  try {
    f.p.sendQQ("C2C_MESSAGE_CREATE", "owned private attachment", {
      id: "peer-asset",
      attachments: [{ url: f.p.url + "/attachment", content_type: "file" }],
    });
    await until(
      async () =>
        !!f.r.store.db
          .prepare("SELECT `id` FROM messages WHERE `native` = ?")
          .all("peer-asset")[0],
    );
    const inbound = (await f.call("read_messages", dm))
      .structuredContent as any;
    const asset = inbound.items[0].assets[0];
    const sent = await f.call("send_message", {
      ...dm,
      request_id: "private-self-history",
      content: [
        { type: "text", text: "SYNTHETIC_PRIVATE_BODY" },
        { type: "file", asset_id: asset.asset_id },
      ],
    });
    expect((sent.structuredContent as any).status).toBe("sent");
    const authorized = (await f.call("read_messages", dm))
      .structuredContent as any;
    expect(
      authorized.items.filter((m: any) => m.direction === "outbound"),
    ).toHaveLength(2);
    expect(
      await (
        await fetch(f.r.http.url + asset.download_path, {
          headers: { Authorization: "Bearer " + f.s.token },
        })
      ).text(),
    ).toBe(f.p.media.toString());
    other = await connect(f.r.http.url, token);
    const denied = await other.callTool({
      name: "read_messages",
      arguments: dm,
    });
    expect(JSON.stringify(denied)).not.toContain("SYNTHETIC_PRIVATE_BODY");
    expect(denied.isError).toBe(true);
    for (const [name, args] of [
      ["get_conversation", dm],
      ["get_asset", { asset_id: asset.asset_id }],
      [
        "send_message",
        {
          ...dm,
          request_id: "denied-send",
          content: [{ type: "text", text: "no" }],
        },
      ],
      [
        "send_message",
        {
          ...qq,
          request_id: "denied-asset",
          content: [{ type: "file", asset_id: asset.asset_id }],
        },
      ],
    ] as const) {
      expect((await other.callTool({ name, arguments: args })).isError).toBe(
        true,
      );
    }
    const listed = await other.callTool({
      name: "list_conversations",
      arguments: { account_id: "qq-main" },
    });
    expect(
      (listed.structuredContent as any).items.map(
        (c: any) => c.conversation_id,
      ),
    ).toEqual(["qq-group"]);
    expect(
      (
        await fetch(f.r.http.url + asset.download_path, {
          headers: { Authorization: "Bearer " + token },
        })
      ).status,
    ).toBe(404);
    expect(f.p.sendCount).toBe(2);
  } finally {
    await other?.close();
    await f.close();
  }
}, 15000);
test("image MIME and bytes preflight reject the entire send before native dispatch", async () => {
  const f = await fixture();
  try {
    const upload = await fetch(f.r.http.url + "/assets", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + f.s.token,
        "Content-Type": "application/octet-stream",
      },
      body: "ordinary nonimage bytes",
    });
    expect(upload.status).toBe(201);
    const asset = (await upload.json()) as any;
    for (const target of [
      qq,
      { account_id: "matrix-main", conversation_id: "matrix-room" },
    ]) {
      const output = await f.call("send_message", {
        ...target,
        request_id: "invalid-image-" + target.account_id,
        content: [
          { type: "text", text: "must not dispatch" },
          { type: "image", asset_id: asset.asset_id },
        ],
      });
      expect(output.isError).toBe(true);
      expect((output.structuredContent as any).error.code).toBe(
        "invalid_request",
      );
    }
    // The stored byte check is independent of an image MIME label: damage only this test-owned asset.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=",
      "base64",
    );
    const image = (await (
      await fetch(f.r.http.url + "/assets", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + f.s.token,
          "Content-Type": "image/png",
        },
        body: png,
      })
    ).json()) as any;
    await writeFile(
      f.r.service.assets.path(
        (await f.r.service.assets.row(image.asset_id))!.storage!,
      ),
      "ordinary nonimage bytes",
    );
    expect(
      (
        await f.call("send_message", {
          ...qq,
          request_id: "damaged-image",
          content: [
            { type: "text", text: "no" },
            { type: "image", asset_id: image.asset_id },
          ],
        })
      ).isError,
    ).toBe(true);
    expect(f.p.sendCount).toBe(0);
    expect(
      f.p.calls.filter(
        (c) => c.path.endsWith("/files") || c.path.includes("/upload"),
      ),
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 15000);
test("expired second QQ reply is failed with no second native submission and stable receipts", async () => {
  const f = await fixture(4000);
  try {
    f.p.sendQQ("GROUP_MESSAGE_CREATE", "reply target", {
      id: "expiring-target",
      timestamp: new Date(Date.now() - 294000).toISOString(),
    });
    await until(
      async () =>
        !!f.r.store.db
          .prepare("SELECT `id` FROM messages WHERE `native` = ?")
          .all("expiring-target")[0],
    );
    const reply = f.r.store.db
      .prepare("SELECT `id` FROM messages WHERE `native` = ?")
      .all("expiring-target")[0] as any;
    f.p.holdNextSend(1400);
    const args = {
      ...qq,
      request_id: "reply-expiry",
      reply_to_message_id: reply.id,
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "expired" },
      ],
    };
    const result = (await f.call("send_message", args))
      .structuredContent as any;
    expect(result.status).toBe("partial");
    expect(result.parts[0]).toMatchObject({
      status: "sent",
      stored: true,
      native_message_ids: ["qq-sent-1"],
    });
    expect(result.parts[1]).toMatchObject({
      status: "failed",
      stored: false,
      native_message_ids: [],
      error: "not_submitted",
    });
    expect((await f.call("send_message", args)).structuredContent).toEqual(
      result,
    );
    expect(f.p.sendCount).toBe(1);
    expect(f.p.calls.filter((c) => c.path.endsWith("/files"))).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 15000);
test("authenticated incomplete MCP body cancels actual TCP request within complete request deadline", async () => {
  const f = await fixture(300);
  let socket: ReturnType<typeof createConnection> | undefined,
    timer: ReturnType<typeof setInterval> | undefined;
  try {
    const url = new URL(f.r.http.url);
    socket = createConnection({ host: "127.0.0.1", port: Number(url.port) });
    await new Promise<void>((resolve, reject) => {
      socket!.once("connect", resolve);
      socket!.once("error", reject);
    });
    const started = performance.now();
    let closed = false,
      response = "",
      drips = 0;
    socket.on("data", (chunk) => (response += chunk.toString()));
    socket.on("error", () => {});
    socket.once("close", () => (closed = true));
    socket.write(
      `POST /mcp HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${f.s.token}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n`,
    );
    const chunk = (value: string) =>
      socket!.write(
        Buffer.byteLength(value).toString(16) + "\r\n" + value + "\r\n",
      );
    chunk('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":');
    timer = setInterval(() => {
      if (!closed) {
        chunk(" ");
        drips++;
      }
    }, 30);
    await until(async () => closed, 700);
    expect(performance.now() - started).toBeLessThan(700);
    expect(drips).toBeGreaterThan(3);
    expect(response).toMatch(/^HTTP\/1.1 408/);
    expect(f.p.sendCount).toBe(0);
    expect({ n: await count(f.r.store.db, "sends") }).toEqual({
      n: 0,
    });
    // Body time is part of the same deadline as native I/O, not a fresh tool timeout.
    f.p.stall();
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "send_message",
        arguments: {
          ...qq,
          request_id: "body-plus-native",
          content: [{ type: "text", text: "bounded" }],
        },
      },
    });
    const begun = performance.now();
    const result = await fetch(f.r.http.url + "/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + f.s.token,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      ...{ duplex: "half" },
      body: new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode(request.slice(0, -1)));
          await new Promise((resolve) => setTimeout(resolve, 200));
          controller.enqueue(new TextEncoder().encode(request.slice(-1)));
          controller.close();
        },
      }),
    });
    const body = (await result.json()) as any;
    expect(performance.now() - begun).toBeLessThan(450);
    expect(body.result.structuredContent.parts[0].status).toBe("unknown");
    await until(async () => f.p.aborts === 1);
    expect(f.p.sendCount).toBe(1);
  } finally {
    if (timer) clearInterval(timer);
    socket?.destroy();
    await f.close();
  }
}, 10000);
function sync(n: number, catchingUp: boolean, events = true) {
  return Response.json({
    next_batch: "review-" + n,
    rooms: {
      join: {
        "!room:fixture": {
          state: {
            events:
              n === 1
                ? [
                    {
                      type: "m.room.member",
                      state_key: "@post:fixture",
                      sender: "@post:fixture",
                      event_id: "$member",
                      origin_server_ts: 1,
                      content: { membership: "join" },
                    },
                  ]
                : [],
          },
          timeline: {
            events: events
              ? [
                  {
                    type: "m.room.message",
                    event_id: "$catchup-" + n,
                    sender: "@owner:fixture",
                    origin_server_ts: Date.now() - 60000,
                    content: {
                      msgtype: "m.text",
                      body: "Post, history " + n,
                      "m.mentions": { user_ids: ["@post:fixture"] },
                    },
                  },
                ]
              : [],
            prev_batch: "before",
            limited: false,
          },
          ephemeral: { events: [] },
          account_data: { events: [] },
        },
      },
    },
    to_device: {
      events: catchingUp
        ? [{ type: "m.dummy", sender: "@owner:fixture", content: {} }]
        : [],
    },
    account_data: { events: [] },
  });
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}
test("actual Matrix SDK suppresses multi-batch startup and reconnect catchup then permits live wakes", async () => {
  const second = gate(),
    drained = gate(),
    live = gate(),
    lost = gate(),
    reconnected = gate(),
    lastCatchup = gate(),
    settled = gate(),
    resumed = gate(),
    park = gate();
  const gates = [
    second,
    drained,
    live,
    lost,
    reconnected,
    lastCatchup,
    settled,
    resumed,
    park,
  ];
  const f = await fixture(4000, (_, p) => {
    p.planSync(() => sync(1, true));
    p.planSync(async () => {
      await second.promise;
      return sync(2, true);
    });
    p.planSync(async () => {
      await drained.promise;
      return sync(3, false, false);
    });
    p.planSync(async () => {
      await live.promise;
      return sync(4, false);
    });
    p.planSync(async () => {
      await lost.promise;
      return Response.json(
        { errcode: "M_UNKNOWN", error: "owned outage" },
        { status: 500 },
      );
    });
    p.planSync(async () => {
      await reconnected.promise;
      return sync(5, true);
    });
    p.planSync(async () => {
      await lastCatchup.promise;
      return sync(6, true);
    });
    p.planSync(async () => {
      await settled.promise;
      return sync(7, false, false);
    });
    p.planSync(async () => {
      await resumed.promise;
      return sync(8, false);
    });
    p.planSync(async () => {
      await park.promise;
      return sync(9, false, false);
    });
  });
  try {
    const bot = f.r.service.platforms.get("matrix-main") as MatrixUserBot;
    const states: any[] = [
      {
        state: bot.client.getSyncState(),
        catchingUp: bot.client.getSyncStateData()?.catchingUp,
      },
    ];
    bot.client.on(ClientEvent.Sync, (state, _old, data) =>
      states.push({ state, catchingUp: data?.catchingUp }),
    );
    const timeline: any[] = [];
    bot.client.on(RoomEvent.Timeline, (event, _r, _s, _removed, data) =>
      timeline.push({
        id: event.getId(),
        liveEvent: data?.liveEvent,
        catchingUp: bot.client.getSyncStateData()?.catchingUp,
      }),
    );
    expect(bot.client.getSyncStateData()?.catchingUp).toBe(true);
    second.release();
    await until(
      async () =>
        !!f.r.store.db
          .prepare("SELECT `id` FROM messages WHERE `native` = ?")
          .all("$catchup-2")[0],
    );
    expect(timeline.find((e) => e.id === "$catchup-2")).toMatchObject({
      liveEvent: true,
      catchingUp: true,
    });
    expect({ n: await count(f.r.store.db, "messages") }).toEqual({ n: 2 });
    expect({ n: await count(f.r.store.db, "deliveries") }).toEqual({ n: 0 });
    drained.release();
    await until(
      async () => bot.client.getSyncStateData()?.catchingUp === false,
    );
    live.release();
    await until(async () => f.receiver.attempts.length === 1);
    lost.release();
    await until(async () => states.some((s) => s.state === "RECONNECTING"));
    reconnected.release();
    await until(
      async () =>
        !!f.r.store.db
          .prepare("SELECT `id` FROM messages WHERE `native` = ?")
          .all("$catchup-5")[0],
      8000,
    );
    lastCatchup.release();
    await until(
      async () =>
        !!f.r.store.db
          .prepare("SELECT `id` FROM messages WHERE `native` = ?")
          .all("$catchup-6")[0],
    );
    expect({ n: await count(f.r.store.db, "deliveries") }).toEqual({ n: 1 });
    expect(f.receiver.attempts).toHaveLength(1);
    settled.release();
    await until(
      async () => bot.client.getSyncStateData()?.catchingUp === false,
    );
    resumed.release();
    await until(async () => f.receiver.attempts.length === 2);
    expect({ n: await count(f.r.store.db, "messages") }).toEqual({ n: 6 });
    expect(f.p.sendCount).toBe(0);
  } finally {
    for (const g of gates) g.release();
    await f.close();
  }
}, 20000);
