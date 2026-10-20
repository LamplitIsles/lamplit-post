// Bundled only into an owned temporary probe; no production/platform endpoints.
import { Application } from "../../src/runtime";
import { platformsFixture } from "./platforms";
import { stateFixture, until } from "./state";
import { existsSync } from "node:fs";
import { join } from "node:path";

async function main() {
  const scenario = process.argv[2];
  const p = await platformsFixture();
  const s = await stateFixture(p.url, "http://127.0.0.1:1", 1500);
  const app = new Application(s.config, { qqOrigin: p.url });
  const realFetch = globalThis.fetch;
  let retired = false;
  let cancelled = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let stopReturned = false;
  try {
    if (scenario === "late-socket") {
      let stopping: Promise<void> | undefined;
      let intake = false;
      app.context.on("http/websocket-init", () => {
        // Real socket is returned from public prepare just as cancellation starts.
        queueMicrotask(() => {
          stopping = app.stop();
        });
      });
      try {
        await app.start();
        intake = true;
      } catch {}
      await stopping;
      console.log(
        JSON.stringify({
          scenario,
          intake,
          sockets: app.host!.sockets.size,
          jobs: app.service!.jobs.size,
          lease: !app.store!.owner.closed,
          connections: p.qqConnections,
        }),
      );
    } else if (scenario === "unreachable") {
      await p.rejectQQConnections();
      const began = Date.now();
      let failed = false;
      try {
        await app.start();
      } catch {
        failed = true;
      }
      await app.stop();
      console.log(
        JSON.stringify({
          scenario,
          failed,
          elapsedMs: Date.now() - began,
          connections: p.qqConnections,
          attempts: p.qqAttempts,
          lease: !app.store!.owner.closed,
          sockets: app.host!.sockets.size,
        }),
      );
    } else {
      if (scenario === "startup-prepare") p.gatewayStall(true);
      if (scenario === "prepare" || scenario === "startup-prepare") {
        // Hold settlement after real native cancellation; lease must cover this actual job.
        globalThis.fetch = async (input, init) => {
          try {
            return await realFetch(input, init);
          } catch (e) {
            if (String(input).endsWith("/gateway")) {
              cancelled = true;
              await gate;
              retired = true;
            }
            throw e;
          }
        };
      }
      const starting = app.start().catch(() => {});
      if (scenario === "startup-prepare") {
        await until(() => p.calls.some((c) => c.path === "/gateway"));
      } else await starting;
      if (scenario === "prepare") p.gatewayStall(true);
      const beforeGateway = p.calls.filter((c) => c.path === "/gateway").length;
      if (scenario !== "startup-prepare") p.disconnectQQ();
      await until(() => !app.service!.platforms.get("qq-main")!.ready);
      if (scenario === "prepare")
        await until(
          () =>
            p.calls.filter((c) => c.path === "/gateway").length > beforeGateway,
        );
      const stopAt = Date.now();
      const stopping = app.stop().then(() => {
        stopReturned = true;
      });
      if (scenario === "prepare" || scenario === "startup-prepare") {
        await until(() => cancelled);
        // Event-loop turn, not an inflated retry/timeout interval.
        await new Promise<void>((r) => setImmediate(r));
        console.log(
          JSON.stringify({
            scenario,
            cancelled,
            retired,
            stopReturned,
            lease: existsSync(join(s.config.data_dir, "owner.lock")),
          }),
        );
        release();
      }
      await stopping;
      const connections = p.qqConnections;
      console.log(
        JSON.stringify({
          scenario,
          retired,
          stoppedMs: Date.now() - stopAt,
          connections,
          jobs: app.service!.jobs.size,
          sockets: app.host!.sockets.size,
          lease: !app.store!.owner.closed,
        }),
      );
      process.once("beforeExit", () =>
        console.log(
          JSON.stringify({ scenario, naturalExitMs: Date.now() - stopAt }),
        ),
      );
    }
  } finally {
    release();
    globalThis.fetch = realFetch;
    await app.stop();
    await p.close();
    await s.close();
  }
}
void main().catch(() => {
  console.error(JSON.stringify({ category: "owned_probe_failed" }));
  process.exitCode = 1;
});
