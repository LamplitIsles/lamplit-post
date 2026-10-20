import { test, expect } from "vitest";
import { consumerFixture } from "./fixtures/consumer";
import { start } from "../src/runtime";
import { platformsFixture } from "./fixtures/platforms";
import { stateFixture, until } from "./fixtures/state";

test("first established QQ socket recovers while Matrix stays ready", async () => {
  const p = await platformsFixture();
  const receiver = await consumerFixture(false);
  const s = await stateFixture(p.url, receiver.url);
  let app: Awaited<ReturnType<typeof start>> | undefined;
  try {
    app = await start(s.config, { qqOrigin: p.url, qqGateway: p.gateway });
    const qq = app.service.platforms.get("qq-main")!;
    const matrix = app.service.platforms.get("matrix-main")!;
    expect(qq.ready && matrix.ready).toBe(true);
    expect((await fetch(app.http.url + "/healthz")).status).toBe(200);
    await until(() => p.qqConnections === 1);
    p.sendQQ("GROUP_AT_MESSAGE_CREATE", "owned before disconnect");
    await until(
      () =>
        app!.store.db
          .prepare("SELECT count(*) n FROM messages WHERE account='qq-main'")
          .get()!.n === 1,
    );
    await until(() => receiver.attempts.length === 1);
    p.disconnectQQ();
    await until(() => !qq.ready);
    expect(matrix.ready).toBe(true);
    expect((await fetch(app.http.url + "/healthz")).status).toBe(503);
    try {
      await until(() => qq.ready, 2500);
    } finally {
      console.log(
        JSON.stringify({
          connections: p.qqConnections,
          closes: p.qqCloses,
          qq: qq.ready,
          matrix: matrix.ready,
          health: (await fetch(app.http.url + "/healthz")).status,
          errors: app.service.errors.size,
        }),
      );
    }
    expect(p.qqConnections).toBe(2);
    expect(matrix.ready).toBe(true);
    expect((await fetch(app.http.url + "/healthz")).status).toBe(200);
    p.sendQQ("GROUP_MESSAGE_CREATE", "owned fresh inbound");
    await until(
      () =>
        app!.store.db
          .prepare("SELECT count(*) n FROM messages WHERE account='qq-main'")
          .get()!.n === 2,
    );
    expect(p.sendCount).toBe(0);
    expect(
      app.store.db.prepare("SELECT count(*) n FROM deliveries").get()!.n,
    ).toBe(1);
    expect(receiver.attempts).toHaveLength(1);
    expect(
      p.calls.filter((c) => c.path === "/app/getAppAccessToken"),
    ).toHaveLength(1);
    expect(app.service.errors.size).toBe(0);
  } finally {
    await app?.stop();
    await p.close();
    await receiver.close();
    await s.close();
  }
});
