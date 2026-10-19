import { test, expect } from "vitest";
import { authorizeQQ } from "../src/qq-connect";
import { createServer, request } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channel } from "node:diagnostics_channel";
import { until } from "./fixtures/state";
import type { startQrConnect } from "@tencent-connect/qqbot-connector";

test("Node24 HTTPS + ALS observes only owned requests; cancel awaits actual close AND SDK terminal, no subscription remains", async () => {
  const dir = await mkdtemp(join(tmpdir(), "post-qq-https-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  let ownResponse: any,
    otherResponse: any,
    ownClosed = false,
    otherClosed = false,
    terminal = false;
  const server = createServer(
    {
      key: await readFile(join(dir, "key.pem")),
      cert: await readFile(join(dir, "cert.pem")),
    },
    (req, res) => {
      req.resume();
      res.writeHead(200);
      res.write("{");
      if (req.url === "/own") {
        ownResponse = res;
        res.once("close", () => (ownClosed = true));
      } else {
        otherResponse = res;
        res.once("close", () => (otherClosed = true));
      }
    },
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = "https://127.0.0.1:" + (server.address() as any).port;
  const events = channel("http.client.request.start"),
    before = events.hasSubscribers;
  let callback: any,
    stopCalls = 0;
  const start: typeof startQrConnect = (cb) => {
    callback = cb;
    const req = request(
      origin + "/own",
      { rejectUnauthorized: false },
      (res) => {
        res.resume();
        res.on("error", () => {
          terminal = true;
          cb.onFailure(Error("fixture"));
        });
        res.on("end", () => {
          terminal = true;
          cb.onSuccess([{ appId: "owned", appSecret: "owned-secret" }]);
        });
      },
    );
    req.on("error", () => {
      terminal = true;
      cb.onFailure(Error("fixture"));
    });
    req.end();
    return () => {
      stopCalls++;
    };
  };
  let other: any;
  try {
    const abort = new AbortController();
    const operation = authorizeQQ(abort.signal, () => {}, start);
    const otherDone = new Promise<void>((resolve, reject) => {
      other = request(
        origin + "/other",
        { rejectUnauthorized: false },
        (res) => {
          res.resume();
          res.on("end", resolve);
        },
      );
      other.on("error", reject);
      other.end();
    });
    await until(() => ownResponse && otherResponse);
    abort.abort();
    expect(await operation.done).toBeNull();
    await until(() => ownClosed);
    expect(terminal).toBe(true);
    expect(stopCalls).toBeGreaterThan(0);
    expect(other.destroyed).toBe(false);
    expect(otherClosed).toBe(false);
    callback.onSuccess([{ appId: "late", appSecret: "must-not-escape" }]);
    expect(await operation.done).toBeNull();
    expect(events.hasSubscribers).toBe(before);
    otherResponse.end("}");
    await otherDone;
    console.info(
      JSON.stringify({
        resource: "qq_native_https",
        node: process.version,
        ownClosed,
        terminal,
        unrelatedPreserved: true,
        subscriptionRestored: events.hasSubscribers === before,
      }),
    );
  } finally {
    other?.destroy();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("QQ cancellation before start, synchronous callback, failure and replacement settle and ignore late results", async () => {
  const abort = new AbortController();
  abort.abort();
  let calls = 0;
  const stopped = authorizeQQ(
    abort.signal,
    () => {},
    () => {
      calls++;
      return () => {};
    },
  );
  expect(await stopped.done).toBeNull();
  expect(calls).toBe(0);
  const controller = new AbortController();
  let cb: any,
    stops = 0;
  const cancelled = authorizeQQ(
    controller.signal,
    () => {},
    (callbacks) => {
      cb = callbacks;
      return () => {
        stops++;
        callbacks.onFailure(Error("safe fixture"));
      };
    },
  );
  await until(() => !!cb);
  controller.abort();
  expect(await cancelled.done).toBeNull();
  cb.onSuccess([{ appId: "late", appSecret: "secret" }]);
  expect(await cancelled.done).toBeNull();
  const next = authorizeQQ(
    new AbortController().signal,
    () => {},
    (callbacks) => {
      callbacks.onSuccess([{ appId: "next", appSecret: "private" }]);
      return () => {
        stops++;
      };
    },
  );
  expect((await next.done)?.appId).toBe("next");
  expect(stops).toBeGreaterThan(0);
  const failed = authorizeQQ(
    new AbortController().signal,
    () => {},
    (callbacks) => {
      callbacks.onFailure(Error("RAW_SECRET"));
      return () => {};
    },
  );
  expect(await failed.done).toBeNull();
});
