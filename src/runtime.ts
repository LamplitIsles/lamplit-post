import { Context, Logger } from "@satorijs/core";
import type { AccountConfig, Config } from "./config";
import { Store, isSqliteError } from "./store";
import { Service } from "./service";
import { Host, type TransportFixture } from "./host";
import { serve } from "./http";
import { Fault } from "./errors";

/** One process owner; each account has an independently retired Cordis scope. */
export class Application {
  context = new Context();
  store?: Store;
  service?: Service;
  host?: Host;
  http?: Awaited<ReturnType<typeof serve>>;
  transportFailed = false;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private stopped = false;
  private supervisors: Promise<void>[] = [];
  private hosts = new Set<Host>();
  private readonly retirementFailures = new Set<string>();
  constructor(
    public config: Config,
    public fixture?: TransportFixture,
    existingStore?: Store,
  ) {
    this.store = existingStore;
    Logger.targets = [];
  }
  start() {
    return (this.starting ??= (async () => {
      if (this.stopped) throw new Error("Application stopped");
      this.store ??= await Store.open(this.config);
      this.checkStarting();
      this.service = new Service(this.store);
      await this.service.startDispatch();
      this.checkStarting();
      this.http = await serve(this.service);
      this.checkStarting();
      this.supervisors = this.config.accounts.map((account, i) =>
        this.supervise(account, i === 0 ? this.context : new Context()).catch(
          (error) => {
            if (isSqliteError(error)) this.service!.storageFailed = true;
            // An unretired scope must never be replaced or release ownership.
            this.retirementFailures.add(account.id);
            this.service!.accountStates.set(account.id, {
              state: "needs_attention",
              reason: null,
              next_retry_at: null,
            });
          },
        ),
      );
      await this.service.status(true);
      this.checkStarting();
    })());
  }
  private async supervise(account: AccountConfig, initial: Context) {
    const service = this.service!;
    let attempts = 0,
      context = initial;
    // Capacity stops capture, not connection recovery or delivery admission.
    const capacity = () => {
      if (service.errors.get(account.id) !== "capacity") return false;
      if (
        service
          .accountBacklog(account.id)
          .some((b) => b.pending + b.held >= b.limit)
      )
        return true;
      service.errors.delete(account.id);
      return false;
    };
    while (!this.stopped && !service.closed) {
      const full = capacity();
      if (!full) service.errors.delete(account.id);
      const host = new Host(service, this.fixture, context, [account]);
      this.host ??= host;
      this.hosts.add(host);
      service.accountStates.set(account.id, {
        state: full ? "needs_attention" : "recovering",
        reason: full ? "capacity" : "connecting",
        next_retry_at: null,
      });
      let reason = "connection_unavailable";
      let attention = false;
      try {
        const connecting = host.start();
        const started = context.start();
        try {
          await Promise.all([connecting, started]);
        } catch (error) {
          await host.stop();
          await Promise.allSettled([connecting, started]);
          throw error;
        }
        if (this.stopped || service.closed) break;
        attempts = 0;
        const full = capacity();
        service.accountStates.set(account.id, {
          state: full ? "needs_attention" : "connected",
          reason: full ? "capacity" : null,
          next_retry_at: null,
        });
        let lostAt = 0;
        while (!this.stopped && !service.closed) {
          await this.wait(500);
          const full = capacity();
          const captureError = service.errors.has(account.id) && !full;
          const ready =
            service.platforms.get(account.id)?.ready && !captureError;
          if (ready) lostAt = 0;
          else if (!lostAt) {
            lostAt = Date.now();
            service.accountStates.set(account.id, {
              state: full ? "needs_attention" : "recovering",
              reason: full ? "capacity" : "connection_unavailable",
              next_retry_at: null,
            });
          } else if (
            Date.now() - lostAt >=
              (account.platform === "matrix" ? 30000 : 3000) ||
            captureError
          )
            break;
          if (ready)
            service.accountStates.set(account.id, {
              state: full ? "needs_attention" : "connected",
              reason: full ? "capacity" : null,
              next_retry_at: null,
            });
        }
        reason = service.errors.get(account.id) ?? reason;
      } catch (error) {
        if (isSqliteError(error)) service.storageFailed = true;
        if (
          host.attentionReason ||
          (error instanceof Fault && error.code === "conflict")
        ) {
          attention = true;
          reason = host.attentionReason ?? "identity_mismatch";
        }
      } finally {
        if (host.attentionReason) {
          attention = true;
          reason = host.attentionReason;
        }
        let retirementError: unknown;
        try {
          await host.stop();
        } catch (error) {
          retirementError = error;
        }
        try {
          await context.stop();
        } catch (error) {
          if (!retirementError || isSqliteError(error)) retirementError = error;
        }
        if (retirementError) throw retirementError;
        this.hosts.delete(host);
        service.platforms.delete(account.id);
      }
      if (this.stopped || service.closed) break;
      if (!attention) {
        if (capacity()) reason = "capacity";
        else if (reason === "capacity") reason = "connection_unavailable";
      }
      attempts++;
      const delay =
        this.fixture?.recoveryDelayMs ??
        (attention
          ? 60000
          : Math.min(60000, 1000 * 2 ** Math.min(attempts - 1, 6)));
      service.accountStates.set(account.id, {
        state:
          attention || reason === "capacity" ? "needs_attention" : "recovering",
        reason,
        next_retry_at: Date.now() + delay,
      });
      await this.wait(delay);
      context = new Context();
    }
  }
  private wait(ms: number) {
    return new Promise<void>((resolve) => {
      const signal = this.service!.stopSignal.signal;
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }
  private checkStarting() {
    if (this.stopped) throw new Error("Application stopped");
  }
  stop(closeStore = true) {
    this.stopped = true;
    return (this.stopping ??= (async () => {
      const domainStopped = this.service?.stop();
      await this.http?.stop();
      const retired = await Promise.allSettled(
        [...this.hosts].map((h) => h.stop()),
      );
      await domainStopped;
      await this.starting?.catch(() => {});
      await Promise.allSettled(this.supervisors);
      await this.http?.stop();
      await this.service?.stop();
      if (
        this.retirementFailures.size ||
        retired.some((result) => result.status === "rejected")
      )
        throw new Error("Account scope retirement failed");
      if (closeStore) await this.store?.close();
    })());
  }
}
export async function start(config: Config, fixture?: TransportFixture) {
  const application = new Application(config, fixture);
  try {
    await application.start();
  } catch (e) {
    await application.stop();
    throw e;
  }
  return {
    context: application.context,
    store: application.store!,
    service: application.service!,
    host: application.host!,
    http: application.http!,
    stop: () => application.stop(),
  };
}
export type Running = Awaited<ReturnType<typeof start>>;
