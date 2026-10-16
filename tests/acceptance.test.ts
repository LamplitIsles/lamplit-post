import { count } from "./fixtures/state";
import { test, expect, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { start } from "../src/runtime";
import { Store } from "../src/store";
import { Service } from "../src/service";
import { serve } from "../src/http";
import { ConfigSchema, parseConfig } from "../src/config";
import { platformsFixture } from "./fixtures/platforms";
import { stateFixture, until } from "./fixtures/state";
import { consumerFixture } from "./fixtures/consumer";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolOutputs, PostEventV1 } from "../contracts/v1/index";

async function fixture(timeout = 1500) {
  const p = await platformsFixture(),
    receiver = await consumerFixture(),
    s = await stateFixture(p.url, receiver.url, timeout);
  const r = await start(s.config, { qqOrigin: p.url, qqGateway: p.gateway });
  const client = new Client({ name: "acceptance", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(r.http.url + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + s.token } },
    }),
  );
  const call = async (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });
  return {
    p,
    receiver,
    s,
    r,
    client,
    call,
    async close() {
      await client.close();
      await r.stop();
      await p.close();
      await receiver.close();
      await s.close();
    },
  };
}
const qq = { account_id: "qq-main", conversation_id: "qq-group" },
  matrix = { account_id: "matrix-main", conversation_id: "matrix-room" };
test("remote asset upload/download, both native file/image roundtrips, audio/video retrieval", async () => {
  const f = await fixture();
  try {
    const headers = {
      Authorization: "Bearer " + f.s.token,
      "Content-Type": "application/octet-stream",
      "X-Post-Filename": "example.bin",
    };
    const upload = await fetch(f.r.http.url + "/assets", {
      method: "POST",
      headers,
      body: f.p.media,
    });
    expect(upload.status).toBe(201);
    const meta = (await upload.json()) as any;
    expect((await fetch(f.r.http.url + meta.download_path)).status).toBe(401);
    expect(
      Buffer.from(
        await (
          await fetch(f.r.http.url + meta.download_path, { headers })
        ).arrayBuffer(),
      ),
    ).toEqual(f.p.media);
    const imageBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=",
      "base64",
    );
    const img = (await (
      await fetch(f.r.http.url + "/assets", {
        method: "POST",
        headers: { ...headers, "Content-Type": "image/png" },
        body: imageBytes,
      })
    ).json()) as any;
    for (const [i, target] of [qq, matrix].entries()) {
      const result = await f.call("send_message", {
        ...target,
        request_id: "media-" + i,
        content: [
          { type: "file", asset_id: meta.asset_id },
          { type: "image", asset_id: img.asset_id },
        ],
      });
      expect(result.isError).not.toBe(true);
      expect((result.structuredContent as any).status).toBe("sent");
      ToolOutputs.send_message.parse(result.structuredContent);
    }
    expect(
      f.p.calls
        .filter((c) => c.path.endsWith("/files"))
        .map((c) => c.body.file_type),
    ).toEqual([4, 1]);
    f.p.sendQQ("GROUP_AT_MESSAGE_CREATE", "", {
      attachments: [
        {
          url: f.p.url + "/attachment",
          content_type: "file",
          filename: "in.bin",
        },
      ],
    });
    for (const [type, mime] of [
      ["m.file", "application/octet-stream"],
      ["m.audio", "audio/ogg"],
      ["m.video", "video/mp4"],
    ])
      f.p.sendMatrix({
        body: "in attachment",
        msgtype: type,
        url: "mxc://fixture/media",
        info: { mimetype: mime },
        "m.mentions": { user_ids: ["@post:fixture"] },
      });
    await until(async () => (await count(f.receiver.db, "inbox")) === 4);
    const deliveries = f.receiver.db
      .prepare("SELECT body FROM inbox")
      .all() as any[];
    for (const row of deliveries) {
      const event = PostEventV1.parse(JSON.parse(row.body));
      expect(event.message.assets.length).toBe(1);
      const a = event.message.assets[0]!;
      expect(a.status).toBe("available");
      const bytes = await fetch(f.r.http.url + a.download_path, { headers });
      expect(Buffer.from(await bytes.arrayBuffer())).toEqual(f.p.media);
    }
    expect(
      (
        await fetch(f.r.http.url + "/assets", {
          method: "POST",
          headers: { ...headers, "Content-Type": "image/png" },
          body: "fake-image",
        })
      ).status,
    ).toBe(415);
  } finally {
    await f.close();
  }
}, 15000);
test("all seven projections and raw assets enforce separate agent scope and private sender deny", async () => {
  const f = await fixture();
  try {
    const other = {
      ...f.r.service.config.bindings[0]!,
      id: "other-binding",
      agent_id: "other",
      scopes: [
        {
          ...f.r.service.config.bindings[0]!.scopes[1]!,
          senders: ["someone-else"],
        },
      ],
    };
    f.r.service.config.bindings.push(other);
    const otherToken = await f.r.store.issue("other");
    f.p.sendQQ("C2C_MESSAGE_CREATE", "private", {
      id: "private-message",
      attachments: [{ url: f.p.url + "/attachment", content_type: "file" }],
    });
    await until(async () => (await count(f.r.store.db, "messages")) === 1);
    const msg = (await f.r.service.message(
      (f.r.store.db.prepare("SELECT `id` FROM messages").all()[0] as any).id,
    ))!;
    const asset = msg.assets[0]!;
    await expect(
      f.r.service.call("other", "read_messages", {
        account_id: "qq-main",
        conversation_id: "qq-dm",
      }),
    ).rejects.toThrow();
    for (const [name, args] of [
      ["get_conversation", qq],
      ["list_members", qq],
      ["read_messages", qq],
      [
        "send_message",
        {
          ...qq,
          request_id: "denied",
          content: [{ type: "text", text: "no" }],
        },
      ],
      ["get_asset", { asset_id: asset.asset_id }],
      ["list_conversations", { account_id: "matrix-main" }],
    ] as const)
      await expect(f.r.service.call("other", name, args)).rejects.toThrow();
    expect(
      (await f.r.service.call("other", "list_accounts", {})).items.map(
        (a: any) => a.account_id,
      ),
    ).toEqual(["qq-main"]);
    expect(
      (
        await fetch(f.r.http.url + asset.download_path, {
          headers: { Authorization: "Bearer " + otherToken },
        })
      ).status,
    ).toBe(404);
    await expect(
      f.r.service.call("other", "send_message", {
        account_id: "qq-main",
        conversation_id: "qq-dm",
        request_id: "stolen",
        content: [{ type: "file", asset_id: asset.asset_id }],
      }),
    ).rejects.toThrow();
    const upload = (await (
      await fetch(f.r.http.url + "/assets", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + f.s.token,
          "Content-Type": "application/octet-stream",
        },
        body: "owned",
      })
    ).json()) as any;
    await expect(
      f.r.service.call("other", "get_asset", { asset_id: upload.asset_id }),
    ).rejects.toThrow();
    f.p.joined(false);
    await expect(
      f.r.service.call("cfl", "read_messages", matrix),
    ).rejects.toThrow();
    f.p.joined(true);
    f.p.encrypted(true);
    await expect(
      f.r.service.call("cfl", "get_conversation", matrix),
    ).rejects.toThrow();
    expect(f.p.sendCount).toBe(0);
  } finally {
    await f.close();
  }
}, 15000);
test("native addressing, verified reply/self suppression, mutations, cursors and member capabilities", async () => {
  const f = await fixture();
  try {
    f.p.sendQQ("GROUP_MESSAGE_CREATE", "a name and @qq-app are ordinary", {
      id: "plain",
    });
    f.p.sendQQ("GROUP_MESSAGE_CREATE", "Post, alias", { id: "alias" });
    f.p.sendQQ("GROUP_AT_MESSAGE_CREATE", "mention", { id: "mention" });
    f.p.sendQQ("GROUP_AT_MESSAGE_CREATE", "echo", {
      id: "echo",
      author: { id: "qq-app" },
    });
    await until(async () => (await count(f.r.store.db, "messages")) === 3);
    await until(async () => (await count(f.receiver.db, "inbox")) === 2);
    const receipt = await f.call("send_message", {
      ...qq,
      request_id: "reply-base",
      content: [{ type: "text", text: "my answer" }],
    });
    const native = (receipt.structuredContent as any).parts[0]
      .native_message_ids[0];
    f.p.sendQQ("GROUP_MESSAGE_CREATE", "reply", {
      id: "reply",
      message_reference: { message_id: native },
    });
    f.p.sendMatrix({
      body: "edit",
      "m.relates_to": { rel_type: "m.replace", event_id: "$original" },
      "m.mentions": { user_ids: ["@post:fixture"] },
    });
    await until(async () => (await count(f.r.store.db, "messages")) === 6);
    await until(async () => (await count(f.receiver.db, "inbox")) === 3);
    const reasons = (
      f.receiver.db.prepare("SELECT body FROM inbox").all() as any[]
    ).map((r) => JSON.parse(r.body).wake.reason);
    expect(new Set(reasons)).toEqual(
      new Set(["alias_matched", "mentioned", "replied_to_self"]),
    );
    const first = await f.r.service.call("cfl", "read_messages", {
      ...qq,
      limit: 1,
    });
    expect(first.items.length).toBe(1);
    expect(first.next_before).toBeTypeOf("string");
    const second = await f.r.service.call("cfl", "read_messages", {
      ...qq,
      limit: 1,
      before: first.next_before,
    });
    expect(second.items[0].id).not.toBe(first.items[0].id);
    await expect(
      f.r.service.call("cfl", "read_messages", {
        ...matrix,
        before: first.next_before,
      }),
    ).rejects.toThrow();
    expect((await f.r.service.call("cfl", "list_members", qq)).capability).toBe(
      "unsupported",
    );
    expect(
      (await f.r.service.call("cfl", "list_members", matrix)).items,
    ).toHaveLength(2);
    f.p.permission(true);
    expect(
      (await f.r.service.call("cfl", "list_members", matrix)).capability,
    ).toBe("permission_required");
    f.p.permission(false);
    const target = first.items[0];
    const sent = await f.call("send_message", {
      ...qq,
      request_id: "native-reply",
      reply_to_message_id: target.id,
      content: [{ type: "text", text: "answer" }],
    });
    expect((sent.structuredContent as any).status).toBe("sent");
    expect(
      f.p.calls.filter((c) => c.path.endsWith("/messages")).at(-1)!.body.msg_id,
    ).toBe(target.native_message_id);
  } finally {
    await f.close();
  }
}, 15000);
test("durable request ledger preserves partial/unknown, rejects conflict, never retries native sends", async () => {
  const f = await fixture(400);
  try {
    f.p.failAt(2);
    const args = {
      ...qq,
      request_id: "partial",
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
        { type: "text", text: "third" },
      ],
    };
    const result = await f.r.service.call("cfl", "send_message", args);
    expect(result.status).toBe("partial");
    expect(result.parts.map((p: any) => p.status)).toEqual([
      "sent",
      "unknown",
      "failed",
    ]);
    expect(f.p.sendCount).toBe(2);
    expect(await f.r.service.call("cfl", "send_message", args)).toEqual(result);
    expect(f.p.sendCount).toBe(2);
    await expect(
      f.r.service.call("cfl", "send_message", {
        ...args,
        content: [{ type: "text", text: "changed" }],
      }),
    ).rejects.toThrow();
    f.p.drip();
    const start = Date.now();
    const unknown = await f.r.service.call("cfl", "send_message", {
      ...matrix,
      request_id: "drip",
      content: [{ type: "text", text: "stall" }],
    });
    expect(
      unknown.status,
      unknown.status === "unknown"
        ? undefined
        : JSON.stringify({
            result: unknown,
            native_sends: f.p.sendCount,
            elapsed_ms: Date.now() - start,
            paths: f.p.calls.map(({ method, path }) => ({ method, path })),
            status: await f.r.service.status(),
          }),
    ).toBe("unknown");
    expect(Date.now() - start).toBeLessThan(1200);
    await until(async () => f.p.aborts > 0);
    f.p.drip(false);
    f.p.stall();
    const pending = f.r.service.track(
      f.r.service.call("cfl", "send_message", {
        ...qq,
        request_id: "shutdown",
        content: [{ type: "text", text: "stall" }],
      }),
    );
    await until(async () => f.p.sendCount === 4);
    const stopping = Date.now();
    await f.r.service.stop();
    expect((await pending).status).toBe("unknown");
    expect(Date.now() - stopping).toBeLessThan(1200);
    await until(async () => f.p.aborts > 1);
  } finally {
    await f.close();
  }
}, 15000);
test("vault ciphertext, wrong-key/tamper failures, exclusive owner, token rotation and identity pins", async () => {
  const s = await stateFixture("http://127.0.0.1:1", "http://127.0.0.1:2");
  try {
    let store = await Store.open(s.config);
    await expect(Store.open(s.config)).rejects.toBeDefined();
    expect(await store.secret("qq-secret", "qq-main", "platform")).toBe(
      "test-qq-platform-secret",
    );
    await store.pin("qq-main", "qq", "qq-app");
    await expect(store.pin("qq-main", "qq", "another")).rejects.toBeDefined();
    const rotated = await store.issue("cfl");
    expect(store.authenticate(s.token)).toBeUndefined();
    expect(store.authenticate(rotated)).toBe("cfl");
    await store.close();
    const bytes = await readFile(join(s.config.data_dir, "post.sqlite"));
    expect(bytes.includes(Buffer.from("test-qq-platform-secret"))).toBe(false);
    expect(bytes.includes(Buffer.from(rotated))).toBe(false);
    await writeFile(s.config.master_key_file, Buffer.alloc(32, 8));
    await expect(Store.open(s.config)).rejects.toBeDefined();
    await writeFile(s.config.master_key_file, Buffer.alloc(32, 7));
    store = await Store.open(s.config);
    store.db
      .prepare("UPDATE vault SET `cipher` = ? WHERE `ref` = ?")
      .run(Buffer.from("tampered"), "qq-secret");
    await expect(
      store.secret("qq-secret", "qq-main", "platform"),
    ).rejects.toBeDefined();
    await store.close();
  } finally {
    await s.close();
  }
});
test("strict config rejects unknown fields, duplicate IDs and unsafe refs", async () => {
  const s = await stateFixture("http://127.0.0.1:1", "http://127.0.0.1:2");
  try {
    expect(ConfigSchema.parse(s.config)).toBeDefined();
    expect(() => parseConfig({ ...s.config, unknown: true })).toThrow();
    expect(() =>
      ConfigSchema.parse({
        ...s.config,
        accounts: [...s.config.accounts, s.config.accounts[0]],
      }),
    ).toThrow();
    expect(() =>
      ConfigSchema.parse({
        ...s.config,
        accounts: [{ ...s.config.accounts[0], credential: "../secret" }],
      }),
    ).toThrow();
  } finally {
    await s.close();
  }
});

test("all part validation precedes native send; confirmation survives actual SQLite persistence failure", async () => {
  const f = await fixture();
  try {
    const target = { account_id: "qq-main", conversation_id: "qq-group" };
    await expect(
      f.r.service.call("cfl", "send_message", {
        ...target,
        request_id: "preflight",
        content: [
          { type: "text", text: "should not send" },
          { type: "file", asset_id: "missing" },
        ],
      }),
    ).rejects.toThrow();
    expect(f.p.sendCount).toBe(0);
    const result = await f.call("send_message", {
      ...target,
      request_id: "mentions",
      content: [
        { type: "mention", native_user_id: "0123456789abcdef0123456789abcdef" },
      ],
    });
    expect((result.structuredContent as any).status).toBe("sent");
    expect(
      f.p.calls.filter((c) => c.path.endsWith("/messages")).at(-1)!.body
        .content,
    ).toBe("<@0123456789abcdef0123456789abcdef>");
    const mx = await f.call("send_message", {
      account_id: "matrix-main",
      conversation_id: "matrix-room",
      request_id: "mx-mention",
      content: [{ type: "mention", native_user_id: "@owner:fixture" }],
    });
    expect((mx.structuredContent as any).status).toBe("sent");
    expect(
      f.p.calls.filter((c) => c.path.includes("/send/m.room.message/")).at(-1)!
        .body["m.mentions"],
    ).toEqual({ user_ids: ["@owner:fixture"] });
    f.r.store.db.exec(
      "CREATE TRIGGER owned_archive_failure BEFORE INSERT ON messages BEGIN SELECT RAISE(FAIL, 'owned archive failure'); END",
    );
    const confirmed = await f.r.service.call("cfl", "send_message", {
      ...target,
      request_id: "confirmed-no-archive",
      content: [{ type: "text", text: "native confirmed" }],
    });
    expect(confirmed.status).toBe("sent");
    expect(confirmed.stored).toBe(false);
    expect(confirmed.parts[0].native_message_ids).toHaveLength(1);
    expect((await f.r.service.status()).healthy).toBe(false);
  } finally {
    await f.close();
  }
}, 15000);

test("oversize/stalled assets fail within bound with no invented bytes; token revocation denies HTTP", async () => {
  const f = await fixture(400);
  try {
    f.r.service.config.max_asset_bytes = 4;
    const headers = {
      Authorization: "Bearer " + f.s.token,
      "Content-Type": "application/octet-stream",
    };
    expect(
      (
        await fetch(f.r.http.url + "/assets", {
          method: "POST",
          headers,
          body: "too-large",
        })
      ).status,
    ).toBe(413);
    const slow = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1]));
      },
    });
    const uploadAbort = new AbortController();
    const then = Date.now();
    expect(
      (
        await fetch(f.r.http.url + "/assets", {
          method: "POST",
          headers,
          signal: uploadAbort.signal,
          body: slow,
          duplex: "half",
        } as any)
      ).status,
    ).toBe(408);
    uploadAbort.abort();
    expect(Date.now() - then).toBeLessThan(1300);
    await f.r.store.revoke("cfl");
    expect(
      (
        await fetch(f.r.http.url + "/assets", {
          method: "POST",
          headers,
          body: "x",
          keepalive: false,
        })
      ).status,
    ).toBe(401);
  } finally {
    await f.close();
  }
}, 15000);

test("Matrix private sender admission and media-only wake use real sync; native rejection is failed", async () => {
  const f = await fixture();
  try {
    f.p.sendMatrix(
      {
        msgtype: "m.file",
        url: "mxc://fixture/file",
        info: { mimetype: "application/octet-stream" },
      },
      { room_id: "!dm:fixture", sender: "@denied:fixture" },
    );
    await until(
      async () =>
        (({ n: await count(f.r.store.db, "messages") }) as any).n === 1,
    );
    expect(
      (
        await f.r.service.call("cfl", "read_messages", {
          account_id: "matrix-main",
          conversation_id: "matrix-dm",
        })
      ).items,
    ).toEqual([]);
    expect(f.receiver.attempts).toHaveLength(0);
    const denied = (await f.r.service.message(
      (f.r.store.db.prepare("SELECT `id` FROM messages").all()[0] as any).id,
    ))!;
    await expect(
      f.r.service.call("cfl", "get_asset", {
        asset_id: denied.assets[0]!.asset_id,
      }),
    ).rejects.toThrow();
    f.p.sendMatrix(
      {
        msgtype: "m.file",
        url: "mxc://fixture/file",
        info: { mimetype: "application/octet-stream" },
      },
      { room_id: "!dm:fixture", sender: "@owner:fixture" },
    );
    await until(async () => f.receiver.attempts.length === 1);
    const accepted = PostEventV1.parse(JSON.parse(f.receiver.attempts[0]!));
    expect(accepted.wake.reason).toBe("direct_message");
    expect(accepted.message.content.every((c) => c.type !== "text")).toBe(true);
    f.p.failAt(1, 400);
    const rejected = await f.r.service.call("cfl", "send_message", {
      ...matrix,
      request_id: "definite-rejection",
      content: [{ type: "text", text: "rejected" }],
    });
    expect(rejected.status).toBe("failed");
    expect(f.p.sendCount).toBe(1);
  } finally {
    await f.close();
  }
}, 15000);
