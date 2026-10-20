import { test, expect, vi } from "vitest";
import { settingsFixture } from "./fixtures/settings";
import { until } from "./fixtures/state";

// A supplied native event tests local capture/history, not Tencent permission to emit it.
test("authorized QQ history retains ordinary events before and after @ independently of mention-only wake", async () => {
  const lines: string[] = [];
  const warn = vi
    .spyOn(console, "warn")
    .mockImplementation((line) => lines.push(String(line)));
  const f = await settingsFixture();
  const tool = async (name: string, args: unknown) => {
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
  const target = { account_id: "qq-main", conversation_id: "qq-group" };
  const read = async (extra = {}) => {
    const r = await tool("read_messages", { ...target, ...extra });
    expect(r.isError).not.toBe(true);
    return r.structuredContent;
  };
  const observed = () =>
    f.app.store.db
      .prepare("SELECT count(*) n FROM messages WHERE account='qq-main'")
      .get()!.n;
  try {
    await f.login();
    const v = await f.app.view();
    const applied = await f.apply("settings", {
      version: v.version,
      accounts: v.accounts.map(({ hasCredential, ready, ...a }) => a),
      agents: v.agents.map(({ hasCredential, hasToken, ...a }) => a),
      bindings: v.bindings.map((b) => ({
        ...b,
        scopes: b.scopes.map(({ name, ...s }) => s),
        wake: { direct: false, mention: true, reply: false, aliases: [] },
      })),
    });
    expect(applied.status).toBe(200);
    f.platform.sendQQ("GROUP_MESSAGE_CREATE", "ordinary before", {
      id: "normal-before",
    });
    await until(() => observed() === 1);
    expect((await read()).items.map((m: any) => m.native_message_id)).toEqual([
      "normal-before",
    ]);
    expect(f.receiver.attempts).toHaveLength(0);
    f.platform.sendQQ("GROUP_AT_MESSAGE_CREATE", "native mention", {
      id: "at-event",
    });
    f.platform.sendQQ("GROUP_MESSAGE_CREATE", "ordinary after", {
      id: "normal-after",
    });
    await until(() => observed() === 3);
    const history = await read();
    expect(history.items.map((m: any) => m.native_message_id)).toEqual([
      "normal-after",
      "at-event",
      "normal-before",
    ]);
    expect(history.items.map((m: any) => m.mentions.self)).toEqual([
      false,
      true,
      false,
    ]);
    const page1 = await read({ limit: 1 });
    expect(page1.items[0].native_message_id).toBe("normal-after");
    const page2 = await read({ limit: 1, before: page1.next_before });
    const page3 = await read({ limit: 1, before: page2.next_before });
    expect(page3.items[0].native_message_id).toBe("normal-before");
    const listing = await tool("list_conversations", { account_id: "qq-main" });
    expect(listing.structuredContent.items).toContainEqual(
      expect.objectContaining({
        ...target,
        type: "group",
        native_id: "qq-group",
      }),
    );
    expect(
      (await tool("get_conversation", target)).structuredContent,
    ).toMatchObject({ ...target, type: "group" });
    await until(() => f.receiver.attempts.length === 1);
    expect(JSON.parse(f.receiver.attempts[0]!).message.native_message_id).toBe(
      "at-event",
    );
    expect(f.platform.sendCount).toBe(0);
    const captures = lines
      .map((line) => JSON.parse(line))
      .filter((r) => r.event === "qq_inbound" && r.stage === "sdk_capture");
    expect(captures.map((r) => r.native_event)).toEqual([
      "GROUP_MESSAGE_CREATE",
      "GROUP_AT_MESSAGE_CREATE",
      "GROUP_MESSAGE_CREATE",
    ]);
  } finally {
    await f.close();
    warn.mockRestore();
  }
});
