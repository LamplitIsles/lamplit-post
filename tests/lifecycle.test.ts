import { test, expect, vi } from "vitest";
import { Context } from "@koishijs/core";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { postPlugin } from "../src/runtime";
import { Service } from "../src/service";
import * as http from "../src/http";
import { platformsFixture } from "./fixtures/platforms";
import { stateFixture, until } from "./fixtures/state";
for (const phase of ["dispatch", "listener"])
  test(
    "disposal retires late startup " + phase,
    async () => {
      const p = await platformsFixture(),
        s = await stateFixture(p.url, "http://127.0.0.1:1", 3000),
        ctx = new Context();
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let entered = false,
        ready = false,
        failed = false,
        stop!: () => Promise<void>,
        bound: Awaited<ReturnType<typeof http.serve>> | undefined,
        ownedAtRetirement = false,
        lateWrites = 0;
      const lock = join(s.config.data_dir, "owner.lock");
      const originalDispatch = Service.prototype.startDispatch,
        originalServe = http.serve;
      const dispatch = vi
        .spyOn(Service.prototype, "startDispatch")
        .mockImplementation(async function (this: Service) {
          for (const method of ["set", "create", "upsert"] as const) {
            const original = this.store.db[method].bind(this.store.db);
            vi.spyOn(this.store.db, method).mockImplementation(((
              ...args: any[]
            ) => {
              if (this.store.owner.closed) lateWrites++;
              return (original as any)(...args);
            }) as any);
          }
          await originalDispatch.call(this);
          if (phase === "dispatch") {
            entered = true;
            await held;
          }
        });
      const serving = vi
        .spyOn(http, "serve")
        .mockImplementation(async (domain) => {
          const actual = await originalServe(domain);
          bound = {
            ...actual,
            stop: async () => {
              ownedAtRetirement = existsSync(lock);
              await actual.stop();
            },
          };
          if (phase === "listener") {
            entered = true;
            await held;
          }
          return bound;
        });
      try {
        const fork = ctx.plugin(
          postPlugin({
            connect: true,
            fixture: { qqOrigin: p.url, qqGateway: p.gateway },
            ready: () => {
              ready = true;
            },
            failed: () => {
              failed = true;
            },
            cleanup: (fn) => (stop = fn),
          }),
          s.config,
        );
        const starting = ctx.start();
        await until(() => entered);
        fork.dispose();
        let stopReturnedBeforeRelease = false;
        const closing = stop().then(() => {
          stopReturnedBeforeRelease = true;
        });
        await new Promise((r) => setTimeout(r, 50));
        const ownerPresentDuringHold = existsSync(lock),
          stoppedEarly = stopReturnedBeforeRelease;
        release();
        await starting;
        await until(() => ready || failed);
        await closing;
        let listenerReachable = false;
        if (bound)
          try {
            await fetch(bound.url + "/healthz");
            listenerReachable = true;
          } catch {}
        const evidence = {
          phase,
          ownerPresentDuringHold,
          stopReturnedBeforeRelease: stoppedEarly,
          ready,
          failed,
          listenerReachable,
          ownedAtRetirement,
          lateWrites,
        };
        expect(evidence).toMatchObject({
          ownerPresentDuringHold: true,
          stopReturnedBeforeRelease: false,
          ready: false,
          failed: true,
          listenerReachable: false,
          lateWrites: 0,
        });
        if (bound) expect(ownedAtRetirement).toBe(true);
      } finally {
        release();
        await bound?.stop();
        await stop?.();
        await ctx.stop();
        vi.restoreAllMocks();
        await p.close();
        await s.close();
      }
    },
    12000,
  );
