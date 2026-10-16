import { count } from "./fixtures/state";
import { test, expect } from "vitest";
import { Store } from "../src/store";
import { Service } from "../src/service";
import { start } from "../src/runtime";
import { stateFixture, until } from "./fixtures/state";
import { platformsFixture } from "./fixtures/platforms";
import { consumerFixture } from "./fixtures/consumer";
import type { Observation, Platform } from "../src/platform";
const event = (native_id: string): Observation => ({
  native_id,
  conversation_native_id: "qq-group",
  conversation_type: "group",
  sender: "qq-owner",
  timestamp: Date.now(),
  content: [{ type: "text", text: "hello" }],
  assets: [],
  mentions: ["qq-app"],
  self_mentioned: true,
  catchup: false,
});
function ready(service: Service) {
  for (const config of service.config.accounts)
    service.platforms.set(config.id, {
      config,
      nativeUserId: config.native_id,
      ready: true,
      async start() {},
      async stop() {},
      async check() {},
      async send() {
        return ["receipt"];
      },
      async members() {
        return { items: [], capability: "unsupported" };
      },
    });
}
test("atomic capture dedupe, byte-identical restart delivery, independent bindings, revocation and receiver hold", async () => {
  const receiver = await consumerFixture(),
    second = await consumerFixture(),
    s = await stateFixture("http://127.0.0.1:1", receiver.url);
  let store: Store | undefined;
  let service: Service | undefined;
  try {
    const binding = s.config.bindings[0]!;
    s.config.bindings.push({
      ...binding,
      id: "second",
      agent_id: "second",
      receiver_url: second.url,
      receiver_credential: "receiver-2",
    });
    store = await Store.open(s.config);
    await store.issue("second");
    await store.putSecret("receiver-2", "second", "receiver", "test-receiver");
    service = new Service(store);
    ready(service);
    await service.observe("qq-main", event("once"));
    await service.observe("qq-main", event("once"));
    expect(({ n: await count(store.db, "messages") } as any).n).toBe(1);
    expect(({ n: await count(store.db, "deliveries") } as any).n).toBe(2);
    const body = (
      (
        await store.db.get(
          "post_deliveries",
          { binding: binding.id },
          { fields: ["body"] },
        )
      )[0] as any
    ).body;
    const oldUrl = binding.receiver_url;
    binding.receiver_url = second.url;
    await service.dispatch(binding);
    expect(
      (
        (
          await store.db.get(
            "post_deliveries",
            { binding: binding.id },
            { fields: ["state"] },
          )
        )[0] as any
      ).state,
    ).toBe("held");
    expect(second.attempts).toHaveLength(0);
    await service.dispatch(s.config.bindings[1]!);
    expect(second.attempts).toHaveLength(1);
    expect(receiver.attempts).toHaveLength(0);
    await service.stop();
    await store.close();
    binding.receiver_url = oldUrl;
    store = await Store.open(s.config);
    service = new Service(store);
    ready(service);
    await service.dispatch(binding);
    expect(receiver.attempts[0]).toBe(body);
    await service.observe("qq-main", event("revoked"));
    await store.revoke("cfl");
    await service.dispatch(binding);
    expect(
      (
        await store.db.get(
          "post_deliveries",
          { binding: binding.id },
          { fields: ["state", "category"], sort: { seq: "desc" }, limit: 1 },
        )
      )[0] as any,
    ).toEqual({ state: "cancelled", category: "agent_revoked" });
  } finally {
    await service?.stop();
    await store?.close();
    await receiver.close();
    await second.close();
    await s.close();
  }
});
test("queue saturation rolls back message and wake together and exposes capture stop", async () => {
  const s = await stateFixture("http://127.0.0.1:1", "http://127.0.0.1:2");
  s.config.backlog_limit = 1;
  const store = await Store.open(s.config),
    service = new Service(store);
  try {
    await service.observe("qq-main", event("first"));
    await expect(
      service.observe("qq-main", event("over-capacity")),
    ).rejects.toBeDefined();
    expect(({ n: await count(store.db, "messages") } as any).n).toBe(1);
    expect(({ n: await count(store.db, "deliveries") } as any).n).toBe(1);
    expect((await service.status()).healthy).toBe(false);
    expect(({ n: await count(store.db, "gaps") } as any).n).toBe(1);
  } finally {
    await service.stop();
    await store.close();
    await s.close();
  }
});
test("actual platform restart stores initial catchup without waking and reopens permanent assets/send ledger", async () => {
  const p = await platformsFixture(),
    receiver = await consumerFixture(),
    s = await stateFixture(p.url, receiver.url);
  let r: Awaited<ReturnType<typeof start>> | undefined;
  try {
    p.seedMatrix([
      {
        type: "m.room.message",
        sender: "@owner:fixture",
        event_id: "$old",
        origin_server_ts: 1,
        content: { body: "Post, old", msgtype: "m.text" },
      },
    ]);
    r = await start(s.config, { qqOrigin: p.url, qqGateway: p.gateway });
    await until(
      async () =>
        (({ n: await count(r!.store.db, "messages") }) as any).n === 1,
    );
    expect(receiver.attempts).toHaveLength(0);
    const asset = await r.service.assets.ingest(
      new Blob(["permanent"]).stream(),
      "application/octet-stream",
      "permanent.bin",
      "cfl",
      r.service.signal(),
    );
    const args = {
      account_id: "qq-main",
      conversation_id: "qq-group",
      request_id: "repeat-after-restart",
      content: [{ type: "text", text: "one send" }],
    };
    const result = await r.service.call("cfl", "send_message", args);
    expect(result.status).toBe("sent");
    await r.store.db.create("post_sends", {
      agent: "cfl",
      request: "crash-pending",
      input: JSON.stringify({
        account_id: "qq-main",
        conversation_id: "qq-group",
        request_id: "crash-pending",
        content: [{ type: "text", text: "pending" }],
      }),
      result: null,
    });
    await r.stop();
    r = undefined;
    r = await start(s.config, { qqOrigin: p.url, qqGateway: p.gateway });
    expect(await r.service.call("cfl", "send_message", args)).toEqual(result);
    expect(p.sendCount).toBe(1);
    expect(
      (await r.service.call("cfl", "get_asset", { asset_id: asset.asset_id }))
        .status,
    ).toBe("available");
    expect((await r.service.assets.bytes(asset.asset_id)).toString()).toBe(
      "permanent",
    );
    const unknown = await r.service.call("cfl", "send_message", {
      account_id: "qq-main",
      conversation_id: "qq-group",
      request_id: "crash-pending",
      content: [{ type: "text", text: "pending" }],
    });
    expect(unknown.status).toBe("unknown");
    expect(p.sendCount).toBe(1);
  } finally {
    await r?.stop();
    await p.close();
    await receiver.close();
    await s.close();
  }
}, 15000);

test("stalled QQ token acquisition cancels actual HTTP and releases startup ownership", async () => {
  const p = await platformsFixture(),
    s = await stateFixture(p.url, "http://127.0.0.1:1", 200);
  try {
    p.tokenStall(true);
    const before = Date.now();
    await expect(
      start(s.config, { qqOrigin: p.url, qqGateway: p.gateway }),
    ).rejects.toThrow();
    expect(Date.now() - before).toBeLessThan(1500);
    await until(async () => p.aborts > 0);
    expect(p.sendCount).toBe(0);
    const store = await Store.open(s.config);
    await store.close();
  } finally {
    await p.close();
    await s.close();
  }
}, 10000);
