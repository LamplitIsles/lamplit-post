import { writeFile, readFile, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { stringify } from "smol-toml";
import { Settings } from "../../src/settings";
import { serveSettings } from "../../src/management";
import { provisionAdmin } from "../../src/admin";
import { platformsFixture } from "./platforms";
import { stateFixture, until } from "./state";
import { consumerFixture } from "./consumer";
import { Store } from "../../src/store";
async function port() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as any).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}
export async function settingsFixture(empty = false) {
  const platform = await platformsFixture(),
    receiver = await consumerFixture(false),
    state = await stateFixture(platform.url, receiver.url);
  const p = await port();
  const config = {
    ...state.config,
    settings: {
      port: p,
      origin: `http://127.0.0.1:${p}`,
      admin_file: state.dir + "/admin.json",
    },
    ...(empty ? { accounts: [], bindings: [] } : {}),
  };
  const path = state.dir + "/post.toml";
  await writeFile(path, stringify(config), { mode: 0o600 });
  await provisionAdmin(config.settings.admin_file, "owned-fixture-password");
  const app = new Settings(path, config, {
    qqOrigin: platform.url,
    qqGateway: platform.gateway,
  });
  await app.start();
  const web = await serveSettings(app);
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
