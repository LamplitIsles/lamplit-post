import type {
  startQrConnect,
  QrConnectCredentials,
} from "@tencent-connect/qqbot-connector";
import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";

/** The public SDK's stop AND terminal callback precede native retirement.
 * Node24's experimental HTTP channel observes only this ALS-owned SDK flow.
 * No HTTP globals, SDK protocol, or unrelated requests are modified.
 */
export function authorizeQQ(
  signal: AbortSignal,
  displayed: (url: string | null) => void,
  start?: typeof startQrConnect,
) {
  const context = new AsyncLocalStorage<boolean>();
  const requests = new Map<ClientRequest, Promise<void>>();
  const events = channel("http.client.request.start");
  let cancelled = signal.aborted;
  let terminal = false;
  let observedRequests = 0;
  let checkingCoverage = false,
    coverage = false;
  let stop: (() => void) | undefined;
  let complete!: (credentials: QrConnectCredentials | null) => void;
  const completed = new Promise<QrConnectCredentials | null>((resolve) => {
    complete = resolve;
  });
  const finish = (credentials: QrConnectCredentials | null) => {
    if (terminal) return;
    terminal = true;
    complete(
      cancelled || (!start && observedRequests === 0) ? null : credentials,
    );
  };
  const observe = (message: unknown) => {
    if (!context.getStore()) return;
    if (checkingCoverage) coverage = true;
    else observedRequests++;
    const { request } = message as { request: ClientRequest };
    let response: IncomingMessage | undefined;
    const deadline = setTimeout(
      () => request.destroy(new Error("QQ authorization deadline")),
      10000,
    );
    request.once("response", (value) => {
      response = value;
    });
    const closed = new Promise<void>((resolve) =>
      request.once("close", () => {
        if (response && !response.closed) response.once("close", resolve);
        else resolve();
      }),
    ).finally(() => {
      clearTimeout(deadline);
      requests.delete(request);
    });
    requests.set(request, closed);
    if (cancelled || terminal)
      request.destroy(new Error("QQ authorization retired"));
  };
  async function checkCoverage() {
    // Fail before any provider call if this runtime does not emit the experimental
    // channel in our ALS context. The probe owns its ephemeral loopback listener.
    checkingCoverage = true;
    const server = createServer((_req, res) => res.end());
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      if (cancelled) return false;
      await new Promise<void>((resolve) => {
        const probe = context.run(true, () =>
          httpRequest(
            {
              hostname: "127.0.0.1",
              port: (server.address() as { port: number }).port,
              agent: false,
              signal,
            },
            (res) => res.resume(),
          ),
        );
        const timer = setTimeout(
          () => probe.destroy(new Error("QQ ownership probe deadline")),
          1000,
        );
        probe.on("error", () => {});
        probe.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        probe.end();
      });
      await Promise.all([...requests.values()]);
      return coverage;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      checkingCoverage = false;
    }
  }
  const cancel = () => {
    cancelled = true;
    stop?.();
    for (const request of requests.keys())
      request.destroy(new Error("QQ authorization retired"));
  };
  events.subscribe(observe);
  signal.addEventListener("abort", cancel, { once: true });
  if (cancelled) finish(null);
  else
    void (async () => {
      try {
        // The published package's require target is misclassified as ESM. Keep the SDK
        // external and use its public import export even from our packaged CJS CLI.
        if (!(await checkCoverage()) || cancelled) {
          finish(null);
          return;
        }
        const connector =
          start ??
          (await import("@tencent-connect/qqbot-connector")).startQrConnect;
        if (cancelled) {
          finish(null);
          return;
        }
        stop = context.run(true, () =>
          connector(
            {
              onSuccess(values) {
                const value = values.length === 1 ? values[0] : undefined;
                finish(
                  value &&
                    typeof value.appId === "string" &&
                    value.appId.length > 0 &&
                    value.appId.length <= 256 &&
                    typeof value.appSecret === "string" &&
                    value.appSecret.length > 0 &&
                    value.appSecret.length <= 16384
                    ? { appId: value.appId, appSecret: value.appSecret }
                    : null,
                );
              },
              onFailure() {
                finish(null);
              },
              onQrDisplayed(url) {
                if (!start && observedRequests === 0) cancel();
                if (!cancelled && !terminal) displayed(url);
              },
              onQrExpired() {
                if (!cancelled && !terminal) displayed(null);
              },
            },
            { signal, displayQrCodeToConsole: false, source: "lamplit-post" },
          ),
        );
        if (cancelled || terminal) stop();
      } catch {
        finish(null);
      }
    })();
  const done = (async () => {
    try {
      const credentials = await completed;
      stop?.();
      // Non-200 native replies can still be streaming after onFailure.
      for (const request of requests.keys())
        request.destroy(new Error("QQ authorization retired"));
      await Promise.all([...requests.values()]);
      return cancelled ? null : credentials;
    } finally {
      signal.removeEventListener("abort", cancel);
      events.unsubscribe(observe);
      context.disable();
    }
  })();
  return { cancel, done };
}
