import { test, expect } from "vitest";
import { settingsFixture } from "./fixtures/settings";
import { until } from "./fixtures/state";
import { start } from "../src/runtime";
import { Content, ToolInputs } from "../contracts/v1/index";

test("public named mentions resolve only selected-chat observed QQ speakers or Matrix joined members and pin retries", async () => {
  const f = await settingsFixture();
  let groupName = "QQ 群聊 1";
  let reopened: Awaited<ReturnType<typeof start>> | undefined;
  let endpoint = () => f.app.app.http!.url;
  const send = async (
    request_id: string,
    name: string,
    target: any = {},
    content?: unknown[],
  ) => {
    const response = await fetch(endpoint() + "/mcp", {
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
        params: {
          name: "send_message",
          arguments: {
            account_id: "qq-main",
            conversation_name: groupName,
            ...target,
            request_id,
            content: content ?? [{ type: "mention", name }],
          },
        },
      }),
    });
    return (await response.json()).result.structuredContent;
  };
  let seq = 0;
  const observed = async (id: string, name?: string, other = false) => {
    const native = "mention-observation-" + ++seq;
    f.platform.sendQQ("GROUP_MESSAGE_CREATE", "owned speaker", {
      id: native,
      ...(other
        ? { group_id: "other-group", group_openid: "other-group" }
        : {}),
      author: { id, ...(name === undefined ? {} : { username: name }) },
    });
    await until(
      () =>
        !!f.app.store.db
          .prepare("SELECT id FROM messages WHERE native=?")
          .get(native),
    );
  };
  try {
    await f.login();
    const alice = "0123456789abcdef0123456789abcdef";
    const bob = "abcdef0123456789abcdef0123456789";
    await observed(alice, "Alice");
    expect.soft((await send("qq-exact", "Alice")).status).toBe("sent");
    expect
      .soft(
        f.platform.calls.filter((c) => c.path.endsWith("/messages")).at(-1)
          ?.body.content,
      )
      .toBe(`<@${alice}>`);
    f.platform.qqGroupName("qq-group", "Observed group");
    expect(
      (await f.request("discover", { account_id: "qq-main" })).status,
    ).toBe(200);
    expect(
      (
        await send("both-names", "Alice", {
          conversation_name: groupName,
        })
      ).status,
    ).toBe("sent");
    const archived = f.app.store.db
      .prepare("SELECT body FROM messages")
      .all()
      .filter((row) => JSON.parse(row.body as string).direction === "outbound");
    expect(archived.length).toBeGreaterThan(0);
    for (const row of archived) {
      const content = JSON.parse(row.body as string).content;
      expect(content).toEqual([{ type: "mention", native_user_id: alice }]);
      expect(Content.safeParse(content[0]).success).toBe(true);
    }
    const baseline = f.platform.sendCount;
    await observed(bob, "Alice");
    expect
      .soft((await send("qq-duplicate", "Alice")).error?.code)
      .toBe("conflict");
    await observed(bob, 'Bob "quoted"');
    await observed("hidden-speaker", "Other only", true);
    await observed("literal-id", "literal-id");
    for (const name of ["Missing", "Other only", "literal-id"])
      expect
        .soft((await send("missing-" + name, name)).error?.code)
        .toBe("not_found");
    expect(f.platform.sendCount).toBe(baseline);
    expect(
      (
        await send("whole-preflight", "Alice", {}, [
          { type: "mention", name: "Alice" },
          { type: "mention", name: "Missing" },
        ])
      ).error.code,
    ).toBe("not_found");
    expect(f.platform.sendCount).toBe(baseline);
    expect(
      (
        await send("parts-pinned", "Alice", {}, [
          { type: "mention", name: "Alice" },
          { type: "mention", name: 'Bob "quoted"' },
        ])
      ).status,
    ).toBe("sent");
    expect(
      JSON.parse(
        f.app.store.db
          .prepare("SELECT input FROM sends WHERE request='parts-pinned'")
          .get()!.input as string,
      ).content,
    ).toEqual([
      { type: "mention", native_user_id: alice },
      { type: "mention", native_user_id: bob },
    ]);
    expect
      .soft(
        (
          await send("direct-denied", "Alice", {
            conversation_name: "QQ 私聊 2",
          })
        ).error?.code,
      )
      .toBe("invalid_request");
    const matrix = {
      account_id: "matrix-main",
      conversation_name: "Matrix 群聊 3",
    };
    expect.soft((await send("mx-exact", "Owner", matrix)).status).toBe("sent");
    expect
      .soft(
        f.platform.calls
          .filter((c) => c.path.includes("/send/m.room.message/"))
          .at(-1)?.body["m.mentions"],
      )
      .toEqual({ user_ids: ["@owner:fixture"] });
    f.platform.permission(true);
    expect
      .soft((await send("mx-permission", "Owner", matrix)).error?.code)
      .toBe("unavailable");
    f.platform.permission(false);
    const beforeMemberDenials = f.platform.sendCount;
    f.platform.matrixMembers({
      "@owner:fixture": { display_name: 'Owner "quoted"' },
      "@other:fixture": { display_name: 'Owner "quoted"' },
    });
    const ambiguous = await send("mx-duplicate", 'Owner "quoted"', matrix);
    expect(ambiguous.error.code).toBe("conflict");
    expect(ambiguous.error.message).toContain(JSON.stringify('Owner "quoted"'));
    expect((await send("mx-missing", "Missing", matrix)).error.code).toBe(
      "not_found",
    );
    f.platform.matrixMembers({}, 401);
    expect((await send("mx-unavailable", "Owner", matrix)).error.code).toBe(
      "unavailable",
    );
    expect(f.platform.sendCount).toBe(beforeMemberDenials);
    f.platform.matrixMembers({
      "@owner:fixture": { display_name: "Renamed owner" },
    });
    f.platform.holdNextSend(100);
    const beforeConcurrent = f.platform.sendCount;
    const concurrent = await Promise.all([
      send("concurrent", "Alice"),
      send("concurrent", "Alice"),
    ]);
    expect.soft(concurrent.some((r) => r.status === "sent")).toBe(true);
    expect.soft(f.platform.sendCount).toBe(beforeConcurrent + 1);
    f.platform.failAt(f.platform.sendCount + 1, 500);
    expect.soft((await send("unknown", "Alice")).status).toBe("unknown");
    const pinned = f.app.store.db
      .prepare("SELECT input FROM sends WHERE request='qq-exact'")
      .get();
    expect
      .soft(pinned && JSON.parse(pinned.input as string).content)
      .toEqual([{ type: "mention", native_user_id: alice }]);
    // Original native-ID caller serialization must reconcile a literal pre-upgrade row.
    const legacy =
      '{"account_id":"qq-main","conversation_id":"qq-group","request_id":"legacy-mention","content":[{"type":"mention","native_user_id":"0123456789abcdef0123456789abcdef"}]}';
    const legacyResult = {
      request_id: "legacy-mention",
      status: "sent",
      parts: [],
      stored: true,
    };
    f.app.store.db
      .prepare("INSERT INTO sends(agent,request,input,result) VALUES(?,?,?,?)")
      .run("cfl", "legacy-mention", legacy, JSON.stringify(legacyResult));
    const nativeResult = await f.app.app.service!.call("cfl", "send_message", {
      account_id: "qq-main",
      conversation_name: groupName,
      request_id: "legacy-mention",
      content: [{ type: "mention", native_user_id: alice }],
    });
    expect(nativeResult).toEqual(legacyResult);
    f.app.store.db
      .prepare("UPDATE sends SET result=NULL WHERE request='concurrent'")
      .run();
    await observed(alice, "Renamed");
    await observed(bob, "Alice");
    const config = f.app.config;
    await f.web.stop();
    await f.app.stop();
    reopened = await start(config, {
      qqOrigin: f.platform.url,
      qqGateway: f.platform.gateway,
    });
    endpoint = () => reopened!.http!.url;
    const callsBefore = f.platform.calls.length;
    const sendsBefore = f.platform.sendCount;
    expect
      .soft(
        (await send("qq-exact", "Alice", { conversation_name: "QQ 群聊 1" }))
          .status,
      )
      .toBe("sent");
    expect.soft((await send("unknown", "Alice")).status).toBe("unknown");
    expect((await send("concurrent", "Alice")).status).toBe("unknown");
    expect((await send("mx-exact", "Owner", matrix)).status).toBe("sent");
    expect
      .soft(
        (await send("qq-exact", "Renamed", { conversation_name: "QQ 群聊 1" }))
          .error?.code,
      )
      .toBe("conflict");
    expect(f.platform.sendCount).toBe(sendsBefore);
    expect(
      f.platform.calls
        .slice(callsBefore)
        .every((c) =>
          ["/sync", "/joined_rooms", "/state"].some((suffix) =>
            c.path.endsWith(suffix),
          ),
        ),
    ).toBe(true);
    reopened.service.config.bindings[0]!.scopes =
      reopened.service.config.bindings[0]!.scopes.filter(
        (s) => s.conversation_id !== "qq-group",
      );
    expect(
      (await send("qq-exact", "Alice", { conversation_name: "QQ 群聊 1" }))
        .error.code,
    ).toBe("not_found");
    expect(f.platform.sendCount).toBe(sendsBefore);
    expect(Content.safeParse({ type: "mention", name: "Alice" }).success).toBe(
      false,
    );
    const base = {
      account_id: "qq-main",
      conversation_name: "QQ 群聊 1",
      request_id: "invalid",
    };
    expect(
      ToolInputs.send_message.safeParse({
        ...base,
        content: [{ type: "mention", name: "Alice", native_user_id: alice }],
      }).success,
    ).toBe(false);
  } finally {
    await reopened?.stop();
    await f.close();
  }
});
