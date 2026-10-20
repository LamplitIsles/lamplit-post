import { writeFile, readFile, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { stringify } from "smol-toml";
import { Settings } from "../../src/settings";
import { serveSettings } from "../../src/management";
import { provisionAdmin } from "../../src/admin";
import { platformsFixture } from "./platforms";
import { stateFixture, until } from "./state";
import { consumerFixture } from "./consumer";
import type { startQrConnect } from "@tencent-connect/qqbot-connector";
import { Store } from "../../src/store";
async function port() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as any).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}
export async function settingsFixture(
  empty = false,
  timeout = 1500,
  connector?: typeof startQrConnect,
  qrLifetime?: number,
  staticRoot?: string,
) {
  const platform = await platformsFixture(),
    receiver = await consumerFixture(false),
    state = await stateFixture(platform.url, receiver.url, timeout);
  const p = await port();
  const config = {
    ...state.config,
    settings: {
      port: p,
      origin: `http://127.0.0.1:${p}`,
      admin_file: state.dir + "/admin.json",
    },
    ...(empty ? { accounts: [], agents: [], bindings: [] } : {}),
  };
  const path = state.dir + "/post.toml";
  await writeFile(path, stringify(config), { mode: 0o600 });
  await provisionAdmin(config.settings.admin_file, "owned-fixture-password");
  const app = new Settings(path, config, {
    qqOrigin: platform.url,
    qqGateway: platform.gateway,
  });
  // Bind before SDK client sockets can consume the selected ephemeral port.
  let web: Awaited<ReturnType<typeof serveSettings>>;
  try {
    web = await serveSettings(app, staticRoot, connector, qrLifetime);
    await app.start();
  } catch (error) {
    await web!?.stop();
    await app.stop();
    await receiver.close();
    await platform.close();
    await state.close();
    throw error;
  }
  let cookie = "",
    csrf = "";
  async function request(
    route: string,
    input?: unknown,
    headers: Record<string, string> = {},
  ) {
    return fetch(config.settings.origin + "/api/" + route, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        cookie,
        origin: config.settings.origin,
        ...(input === undefined
          ? {}
          : { "Content-Type": "application/json", "X-Post-CSRF": csrf }),
        ...headers,
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
  }
  return {
    app,
    platform,
    receiver,
    state,
    web,
    path,
    config,
    request,
    async apply(
      route: string,
      input: unknown,
      headers: Record<string, string> = {},
    ) {
      const response = await request(route, input, headers);
      if (!response.ok) return response;
      await until(async () => !(await (await request("status")).json()).busy);
      return Response.json(await (await request("settings")).json());
    },
    async login() {
      const response = await request("login", {
        password: "owned-fixture-password",
      });
      cookie = response.headers.get("set-cookie")!.split(";")[0];
      csrf = (await response.json()).csrf;
      return response;
    },
    async close() {
      await web.stop();
      await app.stop();
      await receiver.close();
      await platform.close();
      await state.close();
    },
  };
}
