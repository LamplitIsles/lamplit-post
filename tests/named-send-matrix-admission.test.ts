import { expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { settingsFixture } from "./fixtures/settings";
import { until } from "./fixtures/state";

test("named Matrix send reconciliation rechecks platform and local admission without resending", async () => {
  const f = await settingsFixture();
  const client = new Client({ name: "owned-consumer", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.app.app.http!.url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + f.state.token } },
      }),
    );
    const call = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args }))
        .structuredContent as any;
    const items = (
      await call("list_conversations", { account_id: "matrix-main" })
    ).items;
    const group = items.find((c: any) => c.conversation_id === "matrix-room");
    const direct = items.find((c: any) => c.conversation_id === "matrix-dm");
    const groupArgs = {
      account_id: "matrix-main",
      conversation_name: group.name,
      request_id: "matrix-owned-group",
      content: [{ type: "text", text: "owned group" }],
    };
    const accepted = await call("send_message", groupArgs);
    expect(accepted.status).toBe("sent");
    const sent = f.platform.sendCount;
    f.app.store.db
      .prepare("UPDATE conversations SET name=? WHERE id=?")
      .run("Renamed owned room", "matrix-room");
    expect(await call("send_message", groupArgs)).toEqual(accepted);
    expect(f.platform.sendCount).toBe(sent);
    f.platform.joined(false);
    expect((await call("send_message", groupArgs)).error?.code).toBe(
      "not_found",
    );
    f.app.store.db
      .prepare("UPDATE sends SET result=NULL WHERE request=?")
      .run(groupArgs.request_id);
    expect((await call("send_message", groupArgs)).error?.code).toBe(
      "not_found",
    );
    expect(f.platform.sendCount).toBe(sent);
    f.platform.joined(true);
    expect((await call("send_message", groupArgs)).status).toBe("unknown");
    expect(f.platform.sendCount).toBe(sent);
    const directArgs = {
      account_id: "matrix-main",
      conversation_name: direct.name,
      request_id: "matrix-owned-direct",
      content: [{ type: "text", text: "owned direct" }],
    };
    expect((await call("send_message", directArgs)).status).toBe("sent");
    const afterDirect = f.platform.sendCount;
    f.platform.matrixMembers({
      "@owner:fixture": { display_name: "Owner" },
      "@other:fixture": { display_name: "Other" },
    });
    expect((await call("send_message", directArgs)).error?.code).toBe(
      "not_found",
    );
    expect(f.platform.sendCount).toBe(afterDirect);
    f.platform.delayMatrixReads(250);
    const beforeChecks = f.platform.calls.filter((c) =>
      c.path.endsWith("/joined_rooms"),
    ).length;
    const pending = call("send_message", groupArgs);
    await until(
      () =>
        f.platform.calls.filter((c) => c.path.endsWith("/joined_rooms"))
          .length > beforeChecks,
    );
    f.app.app.service!.config.bindings[0]!.scopes =
      f.app.app.service!.config.bindings[0]!.scopes.filter(
        (s) => s.conversation_id !== "matrix-room",
      );
    expect((await pending).error.code).toBe("not_found");
    expect(f.platform.sendCount).toBe(afterDirect);
  } finally {
    await client.close();
    await f.close();
  }
});
