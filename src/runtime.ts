import { Context, Logger } from "@satorijs/core";
import type { Config } from "./config";
import { Store } from "./store";
import { Service } from "./service";
import { Host, type TransportFixture } from "./host";
import { serve } from "./http";
/** One process owner; Cordis owns only platform adapter scopes. */
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
  constructor(
    public config: Config,
    public fixture?: TransportFixture,
    existingStore?: Store,
  ) {
    this.store = existingStore;
    // Upstream SDK errors may contain credentials or message payloads.
    Logger.targets = [];
  }
  start() {
    return (this.starting ??= (async () => {
      if (this.stopped) throw new Error("Application stopped");
      this.store ??= await Store.open(this.config);
      this.checkStarting();
      this.service = new Service(this.store);
      this.checkStarting();
      this.host = new Host(this.service, this.fixture, this.context);
      const connecting = this.host.start();
      try {
        await Promise.all([this.context.start(), connecting]);
      } catch (error) {
        this.transportFailed = true;
        throw error;
      }
      this.checkStarting();
      await this.service.startDispatch();
      this.checkStarting();
      this.http = await serve(this.service);
      await this.service.status(true);
      this.checkStarting();
    })());
  }
  private checkStarting() {
    if (this.stopped) throw new Error("Application stopped");
  }
  stop(closeStore = true) {
    this.stopped = true;
    return (this.stopping ??= (async () => {
      const domainStopped = this.service?.stop();
      await this.http?.stop();
      await domainStopped;
      await this.host?.stop();
      // Retain ownership through resources acquired after stop was requested.
      await this.starting?.catch(() => {});
      await this.http?.stop();
      await this.service?.stop();
      await this.host?.stop();
      await this.context.stop();
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
