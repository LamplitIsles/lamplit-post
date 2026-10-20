import { test, expect, vi } from "vitest";
import { settingsFixture } from "./fixtures/settings";
import { until } from "./fixtures/state";

test("public MCP QQ replies preserve native anchor/sequence and reject old or wrong Post IDs before dispatch; refusal and unknown results never resend", async () => {
  const f = await settingsFixture();
  const sentinel = "SECRET_SENTINEL_MUST_NEVER_LEAVE_SDK_ERROR";
  const warnings: string[] = [];
  const warn = vi
    .spyOn(console, "warn")
    .mockImplementation((line) => warnings.push(String(line)));
  const call = async (name: string, args: unknown) => {
    const response = await fetch(f.app.app.http!.url + "/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + f.state.token,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    expect(response.status).toBe(200);
    return (await response.json()).result;
  };
  const native = (id: string, old = false) =>
    f.platform.sendQQ("GROUP_AT_MESSAGE_CREATE", "owned reply anchor", {
      id,
      timestamp: new Date(Date.now() - (old ? 300000 : 0)).toISOString(),
    });
  const nativeSends = () =>
    f.platform.calls.filter((c) => c.path.endsWith("/messages"));
  try {
    native("fresh-native");
    native("old-native", true);
    f.platform.sendQQ("C2C_MESSAGE_CREATE", "owned other conversation", {
      id: "private-native",
      group_id: undefined,
      group_openid: undefined,
      author: { id: "qq-owner" },
    });
    f.platform.sendMatrix({ body: "owned other account", msgtype: "m.text" });
    await until(
      () =>
        f.app.store.db
          .prepare("SELECT count(*) n FROM messages WHERE account='qq-main'")
          .get()!.n === 3,
    );
    const history = (
      await call("read_messages", {
        account_id: "qq-main",
        conversation_id: "qq-group",
      })
    ).structuredContent.items;
    const fresh = history.find(
      (m: any) => m.native_message_id === "fresh-native",
    );
    const old = history.find((m: any) => m.native_message_id === "old-native");
    const privateHistory = (
      await call("read_messages", {
        account_id: "qq-main",
        conversation_id: "qq-dm",
      })
    ).structuredContent.items;
    await until(
      () =>
        !!f.app.store.db
          .prepare("SELECT id FROM messages WHERE account='matrix-main'")
          .get(),
    );
    const matrixHistory = (
      await call("read_messages", {
        account_id: "matrix-main",
        conversation_id: "matrix-room",
      })
    ).structuredContent.items;
    const base = {
      account_id: "qq-main",
      conversation_id: "qq-group",
      content: [{ type: "text", text: "owned reply" }],
    };
    const send = (request_id: string, reply_to_message_id?: string) =>
      call("send_message", {
        ...base,
        request_id,
        ...(reply_to_message_id ? { reply_to_message_id } : {}),
      });
    for (const [kind, id] of [
      ["old", old.id],
      ["native", "fresh-native"],
      ["missing", "nonexistent"],
      ["cross-conversation", privateHistory[0].id],
      ["cross-account", matrixHistory[0].id],
    ]) {
      const result = await send("invalid-" + kind, id);
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error.code).toBe("invalid_request");
      expect
        .soft(result.structuredContent.error.message)
        .toContain(kind === "old" ? "295 seconds" : "Post message");
    }
    expect(nativeSends()).toHaveLength(0);
    const first = await send("fresh-reply-one", fresh.id);
    expect(first.structuredContent.status).toBe("sent");
    const payload: any = nativeSends()[0]!.body;
    expect(payload.msg_id).toBe("fresh-native");
    expect(payload.msg_seq).toBe(1);
    expect(payload.message_reference.message_id).toBe("fresh-native");
    expect(await send("fresh-reply-one", fresh.id)).toEqual(first);
    expect(nativeSends()).toHaveLength(1);
    expect(
      (await send("fresh-reply-two", fresh.id)).structuredContent.status,
    ).toBe("sent");
    expect((nativeSends()[1]!.body as any).msg_seq).toBe(2);
    f.platform.failAt(f.platform.sendCount + 1, 400, 500, sentinel);
    const rejected = await send("ordinary-refused");
    expect(rejected.structuredContent.parts[0].error).toBe("platform_rejected");
    const before = f.platform.sendCount;
    expect(await send("ordinary-refused")).toEqual(rejected);
    expect(f.platform.sendCount).toBe(before);
    f.platform.failAt(f.platform.sendCount + 1, 500, sentinel, sentinel);
    const unknown = await send("ordinary-unresolved");
    expect(unknown.structuredContent.status).toBe("unknown");
    const attempts = f.platform.sendCount;
    expect(await send("ordinary-unresolved")).toEqual(unknown);
    expect(f.platform.sendCount).toBe(attempts);
    const diagnostic = warnings
      .map((line) => JSON.parse(line))
      .filter((record) => record.event === "qq_send_failure");
    expect.soft(diagnostic).toEqual([
      {
        event: "qq_send_failure",
        stage: "native_handoff",
        category: "platform_rejected",
        http_status: 400,
        native_code: 500,
      },
      {
        event: "qq_send_failure",
        stage: "native_handoff",
        category: "submission_unresolved",
        http_status: 500,
        native_code: null,
      },
    ]);
    expect(JSON.stringify([rejected, unknown, warnings])).not.toContain(
      sentinel,
    );
    expect(JSON.stringify([rejected, unknown, warnings])).not.toContain(
      "qq-transport-secret",
    );
  } finally {
    warn.mockRestore();
    await f.close();
  }
});
