// Public exact-SDK lifecycle probe. Every request, token, listener and process is owned.
import { MatrixClient, ClientEvent, SyncState } from "matrix-js-sdk";
import { createServer } from "node:http";
const scenario = process.argv[2];
let reached, release;
const accepted = new Promise((r) => (reached = r));
const gate = new Promise((r) => (release = r));
let aborts = 0,
  requests = 0,
  lateRequests = 0,
  stopped = false,
  capCalls = 0;
const jobs = new Set();
const closes = [];
let lateSDKAttempts = 0;
let syncCalls = 0,
  versionCalls = 0;
const server = createServer((req, res) => {
  requests++;
  if (stopped) lateRequests++;
  req.resume();
  closes.push(
    new Promise((resolve) =>
      res.once("close", () => {
        if (!res.writableEnded) aborts++;
        resolve();
      }),
    ),
  );
  if (req.url.endsWith("/versions")) versionCalls++;
  if (
    (scenario === "versions" ||
      (scenario === "keepalive" && versionCalls > 1)) &&
    req.url.endsWith("/versions")
  ) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"versions":[');
    reached();
    return;
  }
  if (req.url.endsWith("/versions"))
    return res.end(
      JSON.stringify({ versions: ["v1.11"], unstable_features: {} }),
    );
  if (req.url.endsWith("/capabilities")) {
    capCalls++;
    if (scenario === "capabilities-failure") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"capabilities":');
      reached();
      return;
    }
    return res.end(JSON.stringify({ capabilities: {} }));
  }
  if (scenario === "keepalive" && req.url.includes("/pushrules")) {
    res.writeHead(503);
    return res.end(JSON.stringify({ errcode: "M_UNKNOWN" }));
  }
  if (req.url.includes("/pushrules"))
    return res.end(
      JSON.stringify({
        global: {
          override: [],
          content: [],
          room: [],
          sender: [],
          underride: [],
        },
      }),
    );
  if (req.url.includes("/filter"))
    return res.end(JSON.stringify({ filter_id: "owned" }));
  if (req.url.includes("/sync")) {
    if (syncCalls++ > 0) {
      res.writeHead(200);
      res.write("{");
      return;
    }
    return res.end(
      JSON.stringify({
        next_batch: "owned",
        rooms: {},
        account_data: { events: [] },
        to_device: { events: [] },
        device_lists: { changed: [], left: [] },
      }),
    );
  }
  res.end("{}");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const controller = new AbortController();
const quiet = {
  trace() {},
  debug() {},
  info() {},
  error() {},
  warn() {},
  getChild() {
    return this;
  },
};
const client = new MatrixClient({
  baseUrl: "http://127.0.0.1:" + server.address().port,
  accessToken: "owned-retirement-token",
  userId: "@owned:fixture",
  logger: quiet,
  localTimeoutMs: 1500,
  fetchFn(input, init) {
    if (new URL(input).origin !== "http://127.0.0.1:" + server.address().port)
      return Promise.reject(Error("Non-owned fixture endpoint"));
    if (stopped) {
      lateSDKAttempts++;
      return Promise.reject(Error("Owned closed admission"));
    }
    const isCap = String(input).includes("/capabilities");
    const isFirstVersion =
      String(input).includes("/versions") && versionCalls === 0;
    const call = capCalls;
    const work = (async () => {
      const response = await fetch(input, {
        ...init,
        signal: AbortSignal.any([
          controller.signal,
          ...(init?.signal ? [init.signal] : []),
        ]),
      });
      const bytes = await response.arrayBuffer();
      if (
        (scenario === "restart-versions" && isFirstVersion) ||
        (isCap &&
          ["capabilities-success", "restart"].includes(scenario) &&
          call === 0)
      ) {
        reached();
        await gate; // Complete native body, then deliberately release the old SDK continuation late.
      }
      return new Response(bytes, {
        status: response.status,
        headers: response.headers,
      });
    })();
    jobs.add(work);
    void work.finally(() => jobs.delete(work)).catch(() => {});
    return work;
  },
});
let prepared;
let readiness = new Promise((r) => (prepared = r));
client.on(ClientEvent.Sync, (state) => {
  if (scenario === "keepalive" && state === SyncState.Error)
    client.retryImmediately();
  if (state === SyncState.Prepared) prepared();
});
const firstStart = client.startClient({ initialSyncLimit: 1 });
await accepted;
if (["capabilities-success", "restart"].includes(scenario)) await readiness;
client.stopClient();
stopped = true;
if (["versions", "capabilities-failure", "keepalive"].includes(scenario))
  controller.abort();
if (scenario === "restart-versions") {
  stopped = false;
  const secondStart = client.startClient({ initialSyncLimit: 1 });
  release();
  await Promise.all([firstStart, secondStart]);
  await readiness;
  client.stopClient();
  stopped = true;
} else await firstStart.catch(() => {});
if (scenario === "restart") {
  stopped = false;
  syncCalls = 0;
  readiness = new Promise((r) => (prepared = r));
  await client.startClient({ initialSyncLimit: 1 });
  await readiness;
  release();
  client.stopClient();
  stopped = true;
} else {
  release();
  await Promise.allSettled([...jobs]);
}
controller.abort();
await Promise.allSettled([...jobs]);
server.closeAllConnections();
await new Promise((r) => server.close(r));
await Promise.all(closes);
console.log(
  JSON.stringify({
    scenario,
    nativeAborts: aborts,
    nativeJobs: jobs.size,
    requests,
    lateRequests,
    lateSDKAttempts,
    capabilityRequests: capCalls,
    stopped,
    resources: process.getActiveResourcesInfo(),
  }),
);
// Natural exit is the assertion: no process.exit/unref/global timer manipulation.
