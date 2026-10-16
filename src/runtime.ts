import type {} from "@koishijs/loader";
import type {} from "@koishijs/plugin-server";
import { Context, Logger, Service as FrameworkService } from "@koishijs/core";
import SQLite from "@koishi-ce/plugin-database-sqlite";
import { resolve, join } from "node:path";
import { chmodSync } from "node:fs";
import { ConfigSchema, type Config as PostConfig } from "./config";
import { Ownership } from "./ownership";
import { models, type PostDatabase } from "./models";
import { Store } from "./store";
import { Service } from "./service";
import { Host, type TransportFixture } from "./host";
import { serve } from "./http";
/** Framework extension surface; Post's domain and I/O share this root's provider. */
export class Post extends FrameworkService {
  constructor(
    ctx: Context,
    public store: Store,
    public domain: Service,
  ) {
    super(ctx, "post", true);
  }
}
export interface Running {
  context: Context;
  store: Store;
  service: Service;
  host?: Host;
  http?: Awaited<ReturnType<typeof serve>>;
  stop(): Promise<void>;
}
interface Options {
  connect: boolean;
  fixture?: TransportFixture;
  ready?: (running: Running) => void;
  failed?: (error: unknown) => void;
  cleanup?: (stop: () => Promise<void>) => void;
}
export function postPlugin(options: Options) {
  return {
    name: "post",
    inject: ["model"],
    Config: ConfigSchema,
    apply(ctx: Context, raw: PostConfig) {
      Logger.targets = [];
      let owner: Ownership | undefined;
      let store: Store | undefined,
        domain: Service | undefined,
        host: Host | undefined,
        http: Running["http"];
      let startupTask: Promise<void> | undefined;
      let stopping = false,
        workStop: Promise<void> | undefined,
        stopTask: Promise<void> | undefined;
      let provider: SQLite | undefined,
        providerStart: Promise<void> | undefined,
        providerStop: Promise<void> | undefined;
      // Server's native disposal initiates closure without awaiting socket I/O.
      // Retain its listening barrier and actual handles until Post can release ownership.
      const server = ctx.root.get("server");
      let finishListening = () => {};
      const listening =
        server && !server._http.listening
          ? new Promise<void>((resolve) => {
              finishListening = resolve;
              server._http.once("listening", resolve);
            })
          : Promise.resolve();
      const removeServerError =
        server &&
        ctx.root.on("internal/error", function (error) {
          if (this.scope.runtime.name !== "server") return;
          // The native server's port-probe failure precedes its HTTP listen call.
          finishListening();
          void failStartup(error).catch(() => {});
        });
      const stopUI = async () => {
        if (!server) return;
        await listening;
        server._http.removeListener("listening", finishListening);
        removeServerError?.();
        for (const layer of [...server.wsStack]) layer.close();
        for (const socket of server._ws.clients) socket.terminate();
        await Promise.all([
          new Promise<void>((resolve) => server._ws.close(() => resolve())),
          new Promise<void>((resolve) => {
            server._http.close(() => resolve());
            server._http.closeAllConnections();
          }),
        ]);
      };
      const stopWork = () => {
        stopping = true;
        return (workStop ??= (async () => {
          await stopUI();
          const currentHTTP = http;
          await currentHTTP?.stop();
          await domain?.stop();
          await host?.stop();
          // Startup retains ownership until every in-flight resource acquisition settles.
          await startupTask?.catch(() => {});
          if (http !== currentHTTP) await http?.stop();
        })());
      };
      const stop = () =>
        (stopTask ??= (async () => {
          await stopWork();
          await provider?.stop();
          owner?.close();
        })());
      options.cleanup?.(stop);
      ctx.on("exit", stop);
      ctx.on("dispose", stop, true);
      // Fatal CLI startup must end the application, including sibling status timers.
      // Loader's explicit failure code avoids its default restart code (51).
      let failure: Promise<never> | undefined;
      const failStartup = (error: unknown): Promise<never> =>
        (failure ??= (async () => {
          await stop();
          options.failed?.(error);
          ctx.root.get("loader")?.fullReload(1);
          throw error;
        })());
      try {
        const base = ctx.root.get("loader")?.baseDir ?? process.cwd();
        const config = {
          ...raw,
          data_dir: resolve(base, raw.data_dir),
          master_key_file: resolve(base, raw.master_key_file),
        };
        owner = new Ownership(config);
        models(ctx);
        // Public provider hooks keep schema identification and actual I/O cleanup under one owner.
        class PostSQLite extends SQLite {
          async start() {
            if (stopping) throw new Error("Post stopped during startup");
            provider = this;
            providerStart = (async () => {
              await super.start();
              if (owner!.fresh)
                this.db.exec(
                  "PRAGMA application_id=1347375956; PRAGMA user_version=1;",
                );
            })();
            return providerStart.catch(failStartup);
          }
          async stop() {
            return (providerStop ??= (async () => {
              await stopWork();
              await providerStart?.catch(() => {});
              await super.stop();
            })());
          }
        }
        ctx.plugin(PostSQLite, { path: join(config.data_dir, "post.sqlite") });
        ctx.inject(["database"], (injected) => {
          injected.on("ready", () => {
            startupTask = (async () => {
              chmodSync(join(config.data_dir, "post.sqlite"), 0o600);
              store = new Store(
                config,
                injected.database as unknown as PostDatabase,
                owner!,
              );
              store.close = async () => {
                await stop();
                await ctx.root.stop();
              };
              await store.initialize();
              if (stopping) throw new Error("Post stopped during startup");
              domain = new Service(store);
              await domain.seedConversations();
              if (stopping) throw new Error("Post stopped during startup");
              new Post(injected, store, domain);
              if (options.connect) {
                await listening;
                if (stopping) throw new Error("Post stopped during startup");
                host = new Host(domain, options.fixture, ctx.root);
                await host.start();
                if (stopping) throw new Error("Post stopped during startup");
                await domain.startDispatch();
                if (stopping) throw new Error("Post stopped during startup");
                http = await serve(domain);
                if (stopping) throw new Error("Post stopped during startup");
              }
              const status =
                options.connect && !options.ready
                  ? await domain.status()
                  : undefined;
              if (stopping) throw new Error("Post stopped during startup");
              options.ready?.({
                context: ctx.root,
                store,
                service: domain,
                host,
                http,
                stop: store.close,
              });
              if (options.connect && !options.ready)
                console.log(
                  JSON.stringify({
                    ready: true,
                    url: http!.url,
                    status,
                  }),
                );
            })();
            return startupTask.catch(failStartup);
          });
        });
      } catch (error) {
        return failStartup(error);
      }
    },
  };
}
export const name = "post";
export const Config = ConfigSchema;
export const inject = ["model"];
export function apply(ctx: Context, config: PostConfig) {
  return postPlugin({
    connect: true,
    failed: () => {
      process.exitCode = 1;
    },
  }).apply(ctx, config);
}
async function application(
  config: PostConfig,
  connect: boolean,
  fixture?: TransportFixture,
) {
  const ctx = new Context();
  let cleanup: (() => Promise<void>) | undefined;
  let ready!: (r: Running) => void, failed!: (e: unknown) => void;
  const pending = new Promise<Running>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const timeout = setTimeout(
    () => failed(new Error("Post startup unavailable")),
    config.timeout_ms + 1000,
  );
  try {
    ctx.plugin(
      postPlugin({
        connect,
        fixture,
        ready,
        failed,
        cleanup: (stop) => {
          cleanup = stop;
        },
      }),
      config,
    );
    const [, running] = await Promise.all([ctx.start(), pending]);
    return running;
  } catch (error) {
    await cleanup?.();
    await ctx.stop();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
export async function openStore(config: PostConfig) {
  return (await application(config, false)).store;
}
export async function start(config: PostConfig, fixture?: TransportFixture) {
  const running = await application(config, true, fixture);
  return running as Running & {
    host: Host;
    http: NonNullable<Running["http"]>;
  };
}
