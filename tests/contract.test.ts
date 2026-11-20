import { test, expect } from "vitest";
import {
  PostEventV1,
  Account,
  ToolInputs,
  ToolOutputs,
  ToolError,
  Asset,
} from "../contracts/v1/index";
import examples from "../contracts/v1/examples.json";
import { consumerFixture } from "./fixtures/consumer";
test("canonical examples validate all seven tool contracts and assets", () => {
  PostEventV1.parse(examples.event);
  PostEventV1.parse(examples.keet_event);
  Account.parse(examples.keet_account);
  for (const name of ["get_conversation", "list_members", "read_messages", "send_message"] as const) {
    ToolInputs[name].parse({ ...examples.tools[name].arguments, platform: "keet" });
  }
  Asset.parse(examples.upload.result);
  ToolError.parse(examples.error);
  for (const name of Object.keys(ToolInputs) as (keyof typeof ToolInputs)[]) {
    ToolInputs[name].parse(examples.tools[name].arguments);
    ToolOutputs[name].parse(examples.tools[name].result);
  }
});
test("receiver fixture persists once after outage and acknowledges identical replay", async () => {
  const f = await consumerFixture(true);
  try {
    const body = JSON.stringify(examples.event);
    const send = () =>
      fetch(f.url, {
        method: "POST",
        headers: { Authorization: "Bearer test-receiver" },
        body,
      });
    expect((await send()).status).toBe(503);
    expect((await send()).status).toBe(204);
    expect((await send()).status).toBe(204);
    expect(f.db.prepare("SELECT count(*) AS n FROM inbox").get()).toEqual({
      n: 1,
    });
    expect(new Set(f.attempts).size).toBe(1);
  } finally {
    await f.close();
  }
});
