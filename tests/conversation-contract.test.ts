import { expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { settingsFixture } from "./fixtures/settings";
import { ToolInputs } from "../contracts/v1/index";

test("named conversation tools and old ID ledger reconcile without a native resend", async () => {
  const f = await settingsFixture();
  const client = new Client({ name: "owned-consumer", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.app.app.http!.url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + f.state.token } },
      }),
    );
    const discovered = await client.listTools();
    for (const name of [
      "get_conversation",
      "list_members",
      "read_messages",
      "send_message",
    ]) {
      const schema = discovered.tools.find(
        (tool) => tool.name === name,
      )!.inputSchema;
      expect(schema.required).toContain("conversation_name");
      expect(schema.properties).not.toHaveProperty("conversation_id");
      const { $schema, ...compatible } = schema;
      const validate = new AjvJsonSchemaValidator().getValidator(compatible);
      const sendFields =
        name === "send_message"
          ? { request_id: "owned", content: [{ type: "text", text: "owned" }] }
          : {};
      expect(
        validate({ conversation_name: "Owned", ...sendFields }).valid,
      ).toBe(true);
      expect(
        validate({
          account_id: "qq-main",
          conversation_id: "qq-dm",
          ...sendFields,
        }).valid,
      ).toBe(false);
    }
    const call = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args }))
        .structuredContent as any;
    const conversations = await call("list_conversations", {
      account_id: "qq-main",
    });
    const direct = conversations.items.find(
      (c: any) => c.conversation_id === "qq-dm",
    );
    expect(direct.name).toMatch(/^QQ 私聊 \d+$/);
    const target = { conversation_name: direct.name, account_id: "qq-main" };
    expect((await call("get_conversation", target)).conversation_id).toBe(
      "qq-dm",
    );
    expect((await call("list_members", target)).capability).toBe("unsupported");
    expect((await call("read_messages", target)).items).toEqual([]);

    const incident = await call("send_message", {
      account_id: "qq-main",
      conversation_id: "qq-dm",
      platform: "qq",
      conversation_type: "direct",
      request_id: "invalid",
      content: [{ type: "text", text: "owned" }],
    });
    expect(incident.error).toEqual({
      code: "invalid_request",
      message: "Invalid tool arguments. Check the tool schema.",
    });
    expect(f.platform.sendCount).toBe(0);

    const payload = [{ type: "text", text: "owned" }];
    const oldCaller = {
      account_id: "qq-main",
      conversation_id: "qq-dm",
      request_id: "old-flat",
      content: payload,
      reply_to_message_id: "owned-reply",
    };
    const oldResult = {
      request_id: "old-flat",
      status: "sent",
      parts: [],
      stored: true,
    };
    f.app.store.db
      .prepare("INSERT INTO sends(agent,request,input,result) VALUES(?,?,?,?)")
      .run(
        "cfl",
        "old-flat",
        JSON.stringify(oldCaller),
        JSON.stringify(oldResult),
      );
    expect(
      await call("send_message", {
        ...target,
        request_id: "old-flat",
        content: payload,
        reply_to_message_id: "owned-reply",
      }),
    ).toEqual(oldResult);
    expect(
      (
        await call("send_message", {
          ...target,
          request_id: "old-flat",
          content: [{ type: "text", text: "changed" }],
          reply_to_message_id: "owned-reply",
        })
      ).error.code,
    ).toBe("conflict");
    expect(
      (
        await call("send_message", {
          ...target,
          request_id: "old-flat",
          content: payload,
        })
      ).error.code,
    ).toBe("conflict");

    const renamed = "Owned renamed contact";
    f.app.store.db
      .prepare("UPDATE conversations SET name=? WHERE id=?")
      .run(renamed, "qq-dm");
    expect(
      await call("send_message", {
        conversation_name: renamed,
        request_id: "old-flat",
        content: payload,
        reply_to_message_id: "owned-reply",
      }),
    ).toEqual(oldResult);
    expect(
      (
        await call("send_message", {
          ...target,
          request_id: "old-flat",
          content: payload,
          reply_to_message_id: "owned-reply",
        })
      ).error.code,
    ).toBe("not_found");
    f.app.store.db
      .prepare("UPDATE conversations SET name=? WHERE id=?")
      .run(renamed, "qq-group");
    expect(
      (
        await call("send_message", {
          conversation_name: renamed,
          request_id: "old-flat",
          content: payload,
          reply_to_message_id: "owned-reply",
        })
      ).error.code,
    ).toBe("conflict");
    f.app.store.db
      .prepare("UPDATE conversations SET name=? WHERE id=?")
      .run("Other group", "qq-group");
    expect(
      (
        await call("send_message", {
          conversation_name: "Other group",
          request_id: "old-flat",
          content: payload,
          reply_to_message_id: "owned-reply",
        })
      ).error.code,
    ).toBe("conflict");

    const oldMention = {
      account_id: "qq-main",
      conversation_id: "qq-dm",
      request_id: "old-envelope",
      content: [{ type: "mention", name: "Owned member" }],
    };
    f.app.store.db
      .prepare("INSERT INTO sends(agent,request,input,result) VALUES(?,?,?,?)")
      .run(
        "cfl",
        "old-envelope",
        JSON.stringify({
          caller: JSON.stringify(oldMention),
          target: { account_id: "qq-main", conversation_id: "qq-dm" },
          content: [{ type: "mention", native_user_id: "owned" }],
        }),
        null,
      );
    expect(
      (
        await call("send_message", {
          conversation_name: renamed,
          request_id: "old-envelope",
          content: oldMention.content,
        })
      ).status,
    ).toBe("unknown");

    const oldNamed = ToolInputs.send_message.parse({
      conversation_name: renamed,
      request_id: "old-named",
      content: payload,
    });
    const namedResult = {
      request_id: "old-named",
      status: "unknown",
      parts: [],
      stored: false,
    };
    f.app.store.db
      .prepare("INSERT INTO sends(agent,request,input,result) VALUES(?,?,?,?)")
      .run(
        "cfl",
        "old-named",
        JSON.stringify({
          caller: JSON.stringify(oldNamed),
          target: { account_id: "qq-main", conversation_id: "qq-dm" },
          content: payload,
        }),
        JSON.stringify(namedResult),
      );
    f.app.store.db
      .prepare("UPDATE conversations SET name=? WHERE id=?")
      .run("Renamed again", "qq-dm");
    expect(await call("send_message", oldNamed)).toEqual(namedResult);
    expect(
      (
        await call("send_message", {
          ...oldNamed,
          conversation_name: "Renamed again",
        })
      ).error.code,
    ).toBe("conflict");
    const scope = f.app.app.service!.config.bindings[0]!.scopes.find(
      (s) => s.conversation_id === "qq-dm",
    )!;
    scope.senders = [];
    expect((await call("send_message", oldNamed)).error.code).toBe("not_found");
    expect(
      (
        await call("send_message", {
          conversation_name: "Renamed again",
          request_id: "old-flat",
          content: payload,
          reply_to_message_id: "owned-reply",
        })
      ).error.code,
    ).toBe("not_found");
    expect(f.platform.sendCount).toBe(0);
  } finally {
    await client.close();
    await f.close();
  }
});
