import type { Loader } from "@koishijs/loader";
const loaderRecord: typeof Loader.kRecord = Symbol.for(
  "koishi.loader.record",
) as typeof Loader.kRecord;
import type {} from "@koishijs/plugin-auth";
import type {} from "@koishijs/plugin-logger";
import type {} from "@koishijs/plugin-market";
import type {} from "@koishijs/plugin-server";
import { Context, Logger, Service as FrameworkService } from "@koishijs/core";
import SQLite from "@koishi-ce/plugin-database-sqlite";
import { join } from "node:path";
import { createRequire } from "node:module";
import { chmodSync } from "node:fs";
import {
  ConfigSchema,
  parseConfig,
  postEntries,
  resolveConfigPaths,
  validateApplication,
  type Config as PostConfig,
} from "./config";
import { Ownership } from "./ownership";
import { models, type PostDatabase, type Tables } from "./models";
import { Store } from "./store";
import { Service } from "./service";
import { Host, type TransportFixture } from "./host";
import { serve } from "./http";
import { installSafeLogging, safeLog } from "./logging";
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
      const loader = ctx.root.get("loader");
      if (loader) {
        // Cordis also has a public own baseDir field, which shadows the service.
        ctx.root.baseDir = loader.baseDir;
        ctx.root.set("baseDir", loader.baseDir);
      }
      installSafeLogging();
      if (loader) {
        loader.prolog = [];
        Logger.targets.push({
          colors: 0,
          record(record) {
            loader.prolog.push(record);
            if (loader.prolog.length > 1000) loader.prolog.shift();
          },
        });
      }
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
      let server = ctx.root.get("server");
      let finishListening = () => {};
      let serverFailed = false;
      let listening: Promise<void> | undefined;
      const awaitListening = () => {
        server ??= ctx.root.get("server");
        if (!server || server._http.listening || serverFailed)
          return Promise.resolve();
        return (listening ??= new Promise<void>((resolve) => {
          finishListening = resolve;
          server!._http.once("listening", resolve);
        }));
      };
      const removeServerError = ctx.root.on("internal/error", function (error) {
        if (this.scope.runtime.name !== "server") return;
        serverFailed = true;
        finishListening();
        void failStartup(error).catch(() => {});
      });
      const stopUI = async () => {
        server ??= ctx.root.get("server");
        if (!server) return;
        await awaitListening();
        server._http.removeListener("listening", finishListening);
        removeServerError();
        for (const layer of [...server.wsStack]) layer.close();
        for (const socket of server._ws.clients) socket.terminate();
        await Promise.all([
          new Promise<void>((resolve) => server!._ws.close(() => resolve())),
          new Promise<void>((resolve) => {
            server!._http.close(() => resolve());
            server!._http.closeAllConnections();
          }),
        ]);
      };
      const installs = new Set<Promise<number>>();
      const stopWork = () => {
        stopping = true;
        return (workStop ??= (async () => {
          safeLog("application_stopping");
          await stopUI();
          const currentHTTP = http;
          await currentHTTP?.stop();
          await domain?.stop();
          await host?.stop();
          await Promise.allSettled([...installs]);
          // Startup retains ownership until every in-flight resource acquisition settles.
          await startupTask?.catch(() => {});
          if (http !== currentHTTP) await http?.stop();
        })());
      };
      const stop = () =>
        (stopTask ??= (async () => {
          await stopWork();
          // Native analytics shares this provider. Stop producers before its final flush.
          const analytics = ctx.root.get("console.services.analytics") as any;
          await analytics?.upload(true);
          await ctx.root.parallel("logger/close");
          await provider?.stop();
          owner?.close();
        })());
      if (loader) {
        // A public service bootstrap supplies primitive baseDir once for all native plugins.
        ctx.root.on(
          "console/intercept",
          (client, listener) => {
            const console = ctx.root.get("console");
            const publicRPC = [
              "ping",
              "login/password",
              "login/token",
              "login/platform",
            ];
            if (
              console &&
              publicRPC.some(
                (name) => (console.listeners as any)[name] === listener,
              )
            )
              return false;
            if (ctx.root.get("console.services.entry")?.options === listener)
              return false;
            const ownUser =
              console &&
              Object.entries(console.listeners).some(
                ([name, value]) =>
                  name.startsWith("user/") && value === listener,
              );
            const authority = Math.max(
              listener.authority || 0,
              ownUser ? 1 : 4,
            );
            return (
              !ctx.root.get("auth") ||
              !client.auth ||
              client.auth.expiredAt <= Date.now() ||
              client.auth.authority < authority
            );
          },
          true,
        );
        const nativeReload = loader.fullReload.bind(loader);
        let reloadTask: Promise<void> | undefined;
        loader.fullReload = (code = 51) => {
          reloadTask ??= stop().then(() => nativeReload(code));
          void reloadTask.catch(() => nativeReload(1));
        };
        const reloadPlugin = loader.reload.bind(loader);
        let pendingConfig = false;
        const validateEdit = async (
          parent: Context | undefined,
          key: string,
          source: any,
        ): Promise<void> => {
          const name = key.split(":")[0];
          const fork = parent?.scope[loaderRecord]?.[key];
          if (name === "group") {
            // Native group accept does not await child reload promises. Validate
            // the whole affected subtree before it can update scopes or write YAML.
            for (const [child, config] of Object.entries(source ?? {}))
              if (!child.startsWith("$") && !child.startsWith("~"))
                await validateEdit(fork?.ctx, child, config);
          } else if (["post", "koishi-plugin-post"].includes(name)) {
            if (!fork) throw new Error("One Post application owner required");
            const config = resolveConfigPaths(
              parseConfig(source),
              loader.baseDir,
            );
            if (!store) throw new Error("Post settings not ready");
            await store.checkPins(config);
          }
        };
        let acceptingGroup = false;
        loader.reload = async (parent, key, source) => {
          if (!acceptingGroup) {
            // A read-only view of the sole native YAML, including simultaneous
            // sibling edits. Native Config remains the only writer.
            const replace = (
              plugins: Record<string, any>,
            ): Record<string, any> =>
              plugins === parent.scope.config
                ? { ...plugins, [key]: source }
                : Object.fromEntries(
                    Object.entries(plugins).map(([name, value]) => [
                      name,
                      name.split(":")[0] === "group"
                        ? replace(value ?? {})
                        : value,
                    ]),
                  );
            const proposed = {
              ...loader.config,
              plugins: replace(loader.config.plugins ?? {}),
            };
            const entries = postEntries(proposed.plugins);
            if (entries.length !== 1)
              throw new Error("One Post application owner required");
            const config = resolveConfigPaths(
              parseConfig(entries[0][0][entries[0][1]]),
              loader.baseDir,
            );
            validateApplication(proposed, config, loader.baseDir);
            await validateEdit(parent, key, source);
          }
          const name = key.split(":")[0];
          const fork = parent.scope[loaderRecord]?.[key];
          if (
            ["post", "koishi-plugin-post", "server", "console"].includes(
              name,
            ) &&
            fork
          ) {
            pendingConfig = true;
            return fork;
          }
          if (name !== "group") return reloadPlugin(parent, key, source);
          // Only the synchronous native group accept is covered. Do not keep a
          // validation bypass open while its promise or unrelated RPCs are pending.
          const previous = acceptingGroup;
          acceptingGroup = true;
          try {
            return reloadPlugin(parent, key, source);
          } finally {
            acceptingGroup = previous;
          }
        };
        ctx.root.on("config", () => {
          if (!pendingConfig) return;
          pendingConfig = false;
          // Let native Config finish its write and RPC acknowledgement first.
          setImmediate(() => {
            safeLog("configuration_restart");
            loader.fullReload();
          });
        });
      }
      ctx.inject(["console.services.config"], (injected) => {
        const listener = injected.console.listeners["manager/meta"];
        const update = listener.callback;
        listener.callback = function (ident: string, metadata: unknown) {
          // These are the presentation fields used by native Config's meta RPC.
          // Filters/conditions and domain options must use native reload instead.
          if (
            !metadata ||
            typeof metadata !== "object" ||
            Array.isArray(metadata) ||
            Object.entries(metadata).some(([key, value]) =>
              key === "$label"
                ? value !== null && typeof value !== "string"
                : key === "$collapsed"
                  ? value !== null && typeof value !== "boolean"
                  : true,
            )
          )
            throw new Error("Invalid native metadata");
          return update.call(this, ident, metadata);
        };
      });
      ctx.inject(["auth"], (injected) => {
        // Upstream UserUpdate is a TypeScript type, not a runtime field guard.
        // Keep native password/preferences behavior without accepting role edits.
        const listener = injected.console.listeners["user/update"];
        const update = listener.callback;
        listener.callback = function (data: unknown) {
          if (
            !data ||
            typeof data !== "object" ||
            Array.isArray(data) ||
            Object.keys(data).some(
              (key) => !["name", "password", "config"].includes(key),
            )
          )
            throw new Error("Invalid user settings");
          return update.call(this, data);
        };
      });
      ctx.inject(["installer"], (injected) => {
        const installer = injected.installer;
        const install = installer.install.bind(installer);
        installer.install = (dependencies, forced) => {
          if (stopping) return Promise.resolve(-1);
          // Capture loaded code BEFORE pnpm replaces symlinks. Post-install
          // manifest resolution can retain the old version in Node's cache.
          const modules = createRequire(
            join(loader?.baseDir ?? ctx.root.baseDir, "package.json"),
          );
          const loaded = Object.keys(dependencies).some((name) => {
            try {
              return !!modules.cache[modules.resolve(name)];
            } catch {
              return false;
            }
          });
          safeLog("package_install_started");
          const task = install(dependencies, forced)
            .then((code) => {
              safeLog(
                code ? "package_install_failed" : "package_install_succeeded",
              );
              if (!code && loaded && loader)
                setImmediate(() => loader.fullReload());
              return code;
            })
            .finally(() => installs.delete(task));
          installs.add(task);
          return task;
        };
      });
      ctx.inject(["console.services.analytics"], (injected) => {
        const analytics = injected.get("console.services.analytics") as any;
        const upload = analytics.upload.bind(analytics);
        let task = Promise.resolve();
        analytics.upload = (forced = false) =>
          (task = task.then(() => upload(forced)));
      });
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
        const config = resolveConfigPaths(parseConfig(raw), base);
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
              else {
                // Authenticate existing vault state on this same owned native
                // connection before Minato can prepare new Auth/Analytics tables.
                const check = this.db
                  .prepare("SELECT * FROM post_vault WHERE ref = ?")
                  .get("__keycheck") as unknown as
                  Tables["post_vault"] | undefined;
                if (
                  Store.unseal(
                    owner!.key,
                    check,
                    "__keycheck",
                    "__post",
                    "key_check",
                  ) !== "post-v1"
                )
                  throw new Error("Vault authentication failed");
              }
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
                await awaitListening();
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
              safeLog("application_ready");
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
