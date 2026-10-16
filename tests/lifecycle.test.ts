import { test, expect, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Application } from "../src/runtime";
import { Service } from "../src/service";
import * as http from "../src/http";
import { platformsFixture } from "./fixtures/platforms";
import { stateFixture, until } from "./fixtures/state";
for (const phase of ["dispatch", "listener"])
  test(
    "stop retires late startup " + phase,
    async () => {
      const p = await platformsFixture(),
        s = await stateFixture(p.url, "http://127.0.0.1:1", 3000);
      const app = new Application(s.config, {
        qqOrigin: p.url,
        qqGateway: p.gateway,
      });
      let release!: () => void,
        entered = false,
        ready = false,
        failed = false,
        returned = false,
        ownedAtRetirement = false,
        lateWrites = 0;
      const held = new Promise<void>((r) => (release = r)),
        lock = join(s.config.data_dir, "owner.lock");
      let bound: Awaited<ReturnType<typeof http.serve>> | undefined;
      const originalDispatch = Service.prototype.startDispatch,
        originalServe = http.serve;
      vi.spyOn(Service.prototype, "startDispatch").mockImplementation(
        async function (this: Service) {
          const prepare = this.store.db.prepare.bind(this.store.db);
          vi.spyOn(this.store.db, "prepare").mockImplementation((sql) => {
            if (this.store.owner.closed) lateWrites++;
            return prepare(sql);
          });
          await originalDispatch.call(this);
          if (phase === "dispatch") {
            entered = true;
            await held;
          }
        },
      );
      vi.spyOn(http, "serve").mockImplementation(async (domain) => {
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
        const starting = app.start().then(
          () => {
            ready = true;
          },
          () => {
            failed = true;
          },
        );
        await until(() => entered);
        const closing = app.stop().then(() => {
          returned = true;
        });
        await new Promise((r) => setTimeout(r, 50));
        expect(existsSync(lock)).toBe(true);
        expect(returned).toBe(false);
        release();
        await starting;
        await closing;
        expect({ ready, failed, lateWrites }).toEqual({
          ready: false,
          failed: true,
          lateWrites: 0,
        });
        if (bound) {
          expect(ownedAtRetirement).toBe(true);
          await expect(fetch(bound.url + "/healthz")).rejects.toThrow();
        }
      } finally {
        release();
        await app.stop();
        vi.restoreAllMocks();
        await p.close();
        await s.close();
      }
    },
    12000,
  );

test("stop retains ownership until Matrix background body cancellation retires", async () => {
  const p = await platformsFixture(),
    s = await stateFixture(p.url, "http://127.0.0.1:1", 1500);
  s.config.accounts = s.config.accounts.filter((a) => a.platform === "matrix");
  for (const binding of s.config.bindings)
    binding.scopes = binding.scopes.filter(
      (scope) => scope.account_id === "matrix-main",
    );
  const app = new Application(s.config);
  let release!: () => void;
  const retirement = new Promise<void>((resolve) => (release = resolve));
  let reading = false,
    nativeCancelled = false,
    socketClosed = false,
    bodyRetired = false,
    stopped = false;
  const nativeFetch = globalThis.fetch;
  const fetching = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const response = await nativeFetch(input, init);
      if (
        response.headers.get("X-Owned-Background-Probe") === "1" &&
        response.body
      ) {
        const stream = response.body,
          getReader = stream.getReader.bind(stream);
        stream.getReader = (() => {
          const reader = getReader(),
            cancel = reader.cancel.bind(reader),
            releaseLock = reader.releaseLock.bind(reader);
          // Native cancellation is immediate; its application-level retirement is held.
          reader.cancel = (reason) =>
            cancel(reason).finally(async () => {
              nativeCancelled = true;
              await retirement;
            });
          reader.releaseLock = () => {
            bodyRetired = true;
            releaseLock();
          };
          reading = true;
          return reader;
        }) as typeof stream.getReader;
      }
      return response;
    });
  try {
    await app.start();
    p.planSync(
      (request) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"next_batch":'));
              request.signal.addEventListener(
                "abort",
                () => {
                  socketClosed = true;
                  try {
                    controller.close();
                  } catch {}
                },
                { once: true },
              );
            },
          }),
          {
            headers: {
              "Content-Type": "application/json",
              "X-Owned-Background-Probe": "1",
            },
          },
        ),
    );
    await until(() => reading, 1500);
    const closing = app.stop().then(() => {
      stopped = true;
    });
    await until(() => nativeCancelled && socketClosed, 1500);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bodyRetired).toBe(false);
    expect(app.service!.jobs.size).toBeGreaterThan(0);
    expect(stopped).toBe(false);
    expect(app.store!.owner.closed).toBe(false);
    expect(existsSync(join(s.config.data_dir, "owner.lock"))).toBe(true);
    release();
    await closing;
    expect(bodyRetired).toBe(true);
    const calls = p.calls.length;
    const bot = app.service!.platforms.get(
      "matrix-main",
    ) as import("../src/matrix").MatrixUserBot;
    await expect(bot.client.whoami()).rejects.toThrow();
    expect(p.calls.length).toBe(calls);
    expect(app.service!.jobs.size).toBe(0);
    expect(app.store!.owner.closed).toBe(true);
    expect(existsSync(join(s.config.data_dir, "owner.lock"))).toBe(false);
  } finally {
    release();
    await app.stop();
    fetching.mockRestore();
    await p.close();
    await s.close();
  }
}, 12000);
