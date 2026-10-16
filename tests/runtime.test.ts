import { count } from "./fixtures/state";
import { test, expect } from "vitest";
import { start } from "../src/runtime";
import { platformsFixture } from "./fixtures/platforms";
import { stateFixture, until } from "./fixtures/state";
import { consumerFixture } from "./fixtures/consumer";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
test("real Node Satori QQ WS + Matrix SDK sync, HTTP MCP and durable receiver", async () => {
  const p = await platformsFixture(),
    receiver = await consumerFixture(true),
    state = await stateFixture(p.url, receiver.url);
  let r: Awaited<ReturnType<typeof start>> | undefined;
  let client: Client | undefined;
  try {
    r = await start(state.config, { qqOrigin: p.url, qqGateway: p.gateway });
    expect(
      r.store.db.prepare("SELECT * FROM tokens WHERE `agent` = ?").all("cfl"),
    ).toHaveLength(1);
    client = new Client({ name: "acceptance", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(r.http.url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + state.token } },
      }),
    );
    expect((await client.listTools()).tools.length).toBe(7);
    const invalid = await client.callTool({
      name: "read_messages",
      arguments: {
        account_id: "qq-main",
        conversation_id: "qq-group",
        limit: 101,
      },
    });
    expect(invalid.isError).toBe(true);
    expect((invalid.structuredContent as any).error.code).toBe(
      "invalid_request",
    );
    p.sendQQ("GROUP_MESSAGE_CREATE", "ordinary");
    p.sendQQ("GROUP_AT_MESSAGE_CREATE", "wake");
    p.sendQQ("C2C_MESSAGE_CREATE", "direct");
    await until(
      async () =>
        (({ n: await count(r!.store.db, "messages") }) as any)?.n === 3,
    );
    p.sendMatrix({ body: "Post, hello", msgtype: "m.text" });
    await until(
      async () =>
        (({ n: await count(r!.store.db, "messages") }) as any)?.n === 4,
    );
    const history = await client.callTool({
      name: "read_messages",
      arguments: { account_id: "qq-main", conversation_id: "qq-group" },
    });
    expect((history.structuredContent as any).items.length).toBe(2);
    await until(
      async () =>
        (receiver.db.prepare("SELECT count(*) n FROM inbox").get() as any)
          ?.n === 3,
      5000,
    );
    expect(receiver.attempts[0]).toBe(receiver.attempts[1]);
    const sent = await client.callTool({
      name: "send_message",
      arguments: {
        account_id: "qq-main",
        conversation_id: "qq-group",
        request_id: "r1",
        content: [{ type: "text", text: "outgoing" }],
      },
    });
    expect((sent.structuredContent as any)?.status).toBe("sent");
    const mat = await client.callTool({
      name: "send_message",
      arguments: {
        account_id: "matrix-main",
        conversation_id: "matrix-room",
        request_id: "r2",
        content: [{ type: "text", text: "matrix outgoing" }],
      },
    });
    expect((mat.structuredContent as any)?.status).toBe("sent");
    expect(p.calls.some((c) => c.path === "/app/getAppAccessToken")).toBe(true);
    expect(p.calls.some((c) => c.path.includes("/sync"))).toBe(true);
    p.sendQQ("GROUP_AT_MESSAGE_CREATE", "own echo", {
      id: "native-self-echo",
      author: { id: "qq-user" },
    });
    const nativeMention = "0123456789abcdef0123456789abcdef";
    p.sendQQ("GROUP_MESSAGE_CREATE", `<@${nativeMention}>`, {
      id: "native-self-mention",
      mentions: [{ scope: "single", is_you: true, id: nativeMention }],
    });
    await until(
      async () =>
        !!r!.store.db
          .prepare("SELECT `body` FROM messages WHERE `native` = ?")
          .all("native-self-mention")[0],
    );
    const observed = JSON.parse(
      (
        r.store.db
          .prepare("SELECT `body` FROM messages WHERE `native` = ?")
          .all("native-self-mention")[0] as any
      ).body,
    );
    expect(observed.content).toEqual([
      { type: "mention", native_user_id: nativeMention },
    ]);
    expect(observed.mentions).toEqual({
      self: true,
      native_user_ids: [nativeMention],
    });
    expect(
      r.store.db
        .prepare("SELECT `body` FROM messages WHERE `native` = ?")
        .all("native-self-echo")[0],
    ).toBeUndefined();
    const outbound = JSON.parse(
      (
        r.store.db
          .prepare("SELECT `body` FROM messages WHERE `native` = ?")
          .all("qq-sent-1")[0] as any
      ).body,
    );
    expect(outbound.sender.native_id).toBe("qq-user");
  } catch (e) {
    console.error(
      "runtime evidence",
      p.calls.map((c) => c.path),
      await r?.service.status(),
    );
    throw e;
  } finally {
    await client?.close();
    await r?.stop();
    await p.close();
    await receiver.close();
    await state.close();
  }
}, 15000);

test("stop during startup cancels native I/O before owner release", async () => {
  const { Application } = await import("../src/runtime");
  const { Store } = await import("../src/store");
  const p = await platformsFixture(),
    state = await stateFixture(p.url, "http://127.0.0.1:1", 3000);
  const app = new Application(state.config, {
    qqOrigin: p.url,
    qqGateway: p.gateway,
  });
  try {
    p.tokenStall(true);
    const starting = app.start();
    const rejected = expect(starting).rejects.toThrow();
    await until(() => p.calls.some((c) => c.path === "/app/getAppAccessToken"));
    await app.stop();
    await rejected;
    await until(() => p.aborts > 0);
    const reopened = await Store.open(state.config);
    await reopened.close();
    expect(p.sendCount).toBe(0);
  } finally {
    await app.stop();
    await p.close();
    await state.close();
  }
});
