import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { opaque } from "../../src/store";
/** Real SDK/adapter traffic terminates on owned loopback HTTP/WS only. */
export async function platformsFixture() {
  const calls: {
    method: string;
    path: string;
    body: any;
    auth: string | null;
  }[] = [];
  const sockets = new Set<any>();
  const syncPlan: ((req: Request) => Promise<Response> | Response)[] = [];
  let holdSendMs = 0;
  let syncCount = 0,
    sequence = 0;
  let stopped = false;
  let permission = false,
    tokenStall = false,
    failureStatus = 500;
  let joined = true,
    encrypted = false;
  let aborts = 0;
  let matrixEvents: any[] = [];
  let syncWake: (() => void) | undefined;
  let qqSocket: any;
  let counter = 0;
  let failSendAt = 0;
  let stall = false;
  let drip = false;
  const media = Buffer.from("fixture attachment bytes");
  const child = fork(
    fileURLToPath(new URL("./qq-gateway.cjs", import.meta.url)),
    [],
    { execPath: "node", stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const gatewayPort = await new Promise<number>((resolve, reject) => {
    child.once("message", (m: any) => resolve(m.port));
    child.once("error", reject);
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, server) {
      const u = new URL(req.url),
        path = u.pathname;
      const text = req.method === "GET" ? "" : await req.text();
      let body: any = text;
      try {
        body = JSON.parse(text);
      } catch {}
      calls.push({
        method: req.method,
        path,
        body,
        auth: req.headers.get("authorization"),
      });
      const json = (v: unknown, status = 200) => Response.json(v, { status });
      if (path === "/app/getAppAccessToken" && tokenStall)
        return new Promise<Response>((resolve) =>
          req.signal.addEventListener(
            "abort",
            () => {
              aborts++;
              resolve(new Response(null, { status: 499 }));
            },
            { once: true },
          ),
        );
      if (path === "/app/getAppAccessToken")
        return json({ access_token: "qq-transport-secret", expires_in: 3600 });
      if (path === "/users/@me")
        return json({ id: "qq-user", username: "Test Bot" });
      if (path === "/gateway")
        return json({ url: `ws://127.0.0.1:${gatewayPort}` });
      if (path.includes("/files"))
        return json({ file_uuid: "file", file_info: "file-info", ttl: 300 });
      if (
        path.endsWith("/messages") ||
        path.includes("/send/m.room.message/")
      ) {
        counter++;
        if (holdSendMs) {
          const delay = holdSendMs;
          holdSendMs = 0;
          await Bun.sleep(delay);
        }
        if (failSendAt === counter)
          return json(
            { code: 500, message: "test failure", errcode: "M_UNKNOWN" },
            failureStatus,
          );
        if (stall)
          return new Promise<Response>((resolve) => {
            req.signal.addEventListener(
              "abort",
              () => {
                aborts++;
                resolve(new Response(null, { status: 499 }));
              },
              { once: true },
            );
          });
        if (drip)
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"id":"'));
                req.signal.addEventListener(
                  "abort",
                  () => {
                    aborts++;
                    try {
                      controller.close();
                    } catch {}
                  },
                  { once: true },
                );
              },
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        return path.includes("m.room.message")
          ? json({ event_id: "$sent-" + counter })
          : json({
              id: "qq-sent-" + counter,
              timestamp: new Date().toISOString(),
            });
      }
      if (path.includes("/upload"))
        return json({ content_uri: "mxc://fixture/upload" });
      if (path.includes("/download/") || path === "/attachment")
        return new Response(media, {
          headers: { "Content-Type": "application/octet-stream" },
        });
      if (path === "/image")
        return new Response(
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=",
            "base64",
          ),
          { headers: { "Content-Type": "image/png" } },
        );
      if (path.endsWith("/versions"))
        return json({ versions: ["v1.11"], unstable_features: {} });
      if (path.endsWith("/whoami")) return json({ user_id: "@post:fixture" });
      if (path.endsWith("/joined_rooms"))
        return json({
          joined_rooms: joined ? ["!room:fixture", "!dm:fixture"] : [],
        });
      if (path.endsWith("/joined_members") && permission)
        return json({ errcode: "M_FORBIDDEN" }, 403);
      if (path.endsWith("/joined_members"))
        return json({
          joined: {
            "@owner:fixture": { display_name: "Owner" },
            "@post:fixture": { display_name: "Post" },
          },
        });
      if (path.endsWith("/state"))
        return json([
          ...(encrypted
            ? [
                {
                  type: "m.room.encryption",
                  content: { algorithm: "m.megolm.v1.aes-sha2" },
                },
              ]
            : []),
          {
            type: "m.room.member",
            state_key: "@post:fixture",
            content: { membership: "join" },
          },
        ]);
      if (path.endsWith("/filter")) return json({ filter_id: "f" });
      if (path.endsWith("/pushrules/"))
        return json({
          global: {
            override: [],
            content: [],
            room: [],
            sender: [],
            underride: [],
          },
        });
      if (path.endsWith("/sync")) {
        if (syncPlan.length) return syncPlan.shift()!(req);
        if (syncCount++ > 0 && !matrixEvents.length && !stopped)
          await new Promise<void>((r) => {
            const timer = setTimeout(done, 300);
            function done() {
              clearTimeout(timer);
              req.signal.removeEventListener("abort", done);
              syncWake = undefined;
              r();
            }
            syncWake = done;
            req.signal.addEventListener("abort", done, { once: true });
          });
        const events = matrixEvents;
        matrixEvents = [];
        return json({
          next_batch: "sync-" + syncCount,
          rooms: {
            join: {
              "!room:fixture": {
                state: {
                  events: [
                    {
                      type: "m.room.member",
                      state_key: "@post:fixture",
                      sender: "@post:fixture",
                      content: { membership: "join" },
                      event_id: "$member",
                      origin_server_ts: 1,
                    },
                  ],
                },
                timeline: {
                  events: events.filter((e) => e.room_id !== "!dm:fixture"),
                  prev_batch: "before",
                  limited: false,
                },
                ephemeral: { events: [] },
                account_data: { events: [] },
                unread_notifications: {},
              },
              "!dm:fixture": {
                state: { events: [] },
                timeline: {
                  events: events.filter((e) => e.room_id === "!dm:fixture"),
                  prev_batch: "before",
                  limited: false,
                },
              },
            },
          },
          account_data: { events: [] },
          to_device: { events: [] },
          device_lists: { changed: [], left: [] },
        });
      }
      return json({});
    },
  });
  return {
    calls,
    media,
    planSync(handler: (req: Request) => Promise<Response> | Response) {
      syncPlan.push(handler);
      syncWake?.();
    },
    holdNextSend(ms: number) {
      holdSendMs = ms;
    },
    url: `http://127.0.0.1:${server.port}`,
    gateway: `ws://127.0.0.1:${gatewayPort}`,
    sendQQ(type: string, content = "hello", extra: any = {}) {
      child.send({
        op: 0,
        t: type,
        s: ++sequence,
        d: {
          id: opaque("qq"),
          timestamp: new Date().toISOString(),
          content,
          group_id: "qq-group",
          group_openid: "qq-group",
          author: { id: "qq-owner" },
          ...extra,
        },
      });
    },
    sendMatrix(
      content: any = { body: "hello", msgtype: "m.text" },
      extra: any = {},
    ) {
      matrixEvents.push({
        type: "m.room.message",
        sender: "@owner:fixture",
        room_id: "!room:fixture",
        event_id: opaque("$"),
        origin_server_ts: Date.now(),
        content,
        ...extra,
      });
      syncWake?.();
    },
    seedMatrix(events: any[]) {
      matrixEvents.push(...events);
    },
    permission(v: boolean) {
      permission = v;
    },
    joined(v: boolean) {
      joined = v;
    },
    encrypted(v: boolean) {
      encrypted = v;
    },
    get aborts() {
      return aborts;
    },
    tokenStall(v: boolean) {
      tokenStall = v;
    },
    failAt(n: number, status = 500) {
      failSendAt = n;
      failureStatus = status;
    },
    get sendCount() {
      return counter;
    },
    stall(v = true) {
      stall = v;
    },
    drip(v = true) {
      drip = v;
    },
    async close() {
      stopped = true;
      syncWake?.();
      child.send({ close: true });
      await new Promise<void>((r) => child.once("exit", () => r()));
      await server.stop(true);
    },
  };
}
