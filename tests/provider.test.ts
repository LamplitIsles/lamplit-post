import { test, expect } from "vitest";
import { Store } from "../src/store";
import { Service } from "../src/service";
import { stateFixture, count } from "./fixtures/state";
import type { Observation } from "../src/platform";
const observation = (id: string): Observation => ({
  native_id: id,
  conversation_native_id: "qq-group",
  conversation_type: "group",
  sender: "qq-owner",
  timestamp: Date.now(),
  content: [{ type: "text", text: "wake" }],
  assets: [],
  mentions: [],
  self_mentioned: true,
  catchup: false,
});
test("native synchronous domain transactions roll back and serialize concurrent observations", async () => {
  const s = await stateFixture("http://127.0.0.1:1", "http://127.0.0.1:2"),
    store = await Store.open(s.config),
    service = new Service(store);
  try {
    expect(() =>
      store.transaction((db) => {
        db.prepare("INSERT INTO gaps(account,category,at) VALUES(?,?,?)").run(
          "rollback",
          "test",
          1,
        );
        throw Error("owned rollback");
      }),
    ).toThrow("owned rollback");
    expect(await count(store.db, "gaps")).toBe(0);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        service.observe("qq-main", observation("ordered-" + i)),
      ),
    );
    expect(await count(store.db, "messages")).toBe(20);
    expect(await count(store.db, "deliveries")).toBe(20);
    const seq = store.db
      .prepare("SELECT seq FROM messages ORDER BY seq")
      .all()
      .map((r) => r.seq);
    expect(seq).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    await Promise.all(
      Array.from({ length: 10 }, () =>
        service.observe("qq-main", observation("same")),
      ),
    );
    expect(await count(store.db, "messages")).toBe(21);
    expect(await count(store.db, "deliveries")).toBe(21);
    expect(() =>
      store.db
        .prepare(
          "INSERT INTO conversations(id,account,native,type) VALUES(?,?,?,?)",
        )
        .run("different", "qq-main", "qq-group", "group"),
    ).toThrow();
    expect(store.db.prepare("PRAGMA synchronous").get()).toEqual({
      synchronous: 2,
    });
  } finally {
    await service.stop();
    await store.close();
    await s.close();
  }
});
