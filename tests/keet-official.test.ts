import { test, expect } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { KeetSidecar } from "../src/keet-sidecar";
import { KeetPlatform } from "../src/keet";
import { ConfigSchema } from "../src/config";
import { Service } from "../src/service";
import { Store } from "../src/store";

// Explicit opt-in; the caller must enter a network namespace. Every identity is disposable.
test.skipIf(!process.env.POST_KEET_TEST_RUNTIME)(
  "Post adapter sends against the pinned official worker",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "post-keet-official-adapter-"));
    const identity = join(root, "identity");
    await mkdir(identity);
    const runtime = process.env.POST_KEET_TEST_RUNTIME!;
    const probe = new KeetSidecar(runtime, identity, 10000, false);
    let store: Store | undefined, platform: KeetPlatform | undefined;
    try {
      await probe.start();
      const native = (await probe.call(6, [])) as { memberId: string };
      const room = (await probe.call(25, [
        { config: { title: "Post fixture" } },
      ])) as string;
      await probe.stop();
      const config = ConfigSchema.parse({
        data_dir: join(root, "data"),
        master_key_file: join(root, "master"),
        keet_runtime_dir: runtime,
        timeout_ms: 10000,
        accounts: [
          {
            id: "keet",
            platform: "keet",
            identity_dir: identity,
            native_id: native.memberId,
          },
        ],
        agents: [
          {
            id: "agent",
            receiver_url: "http://127.0.0.1:1",
            receiver_credential: "receiver",
          },
        ],
        bindings: [
          {
            id: "binding",
            agent_id: "agent",
            account_ids: ["keet"],
            scopes: [],
            wake: {},
          },
        ],
      });
      store = await Store.open(config);
      const service = new Service(store);
      platform = new KeetPlatform(config.accounts[0]!, service, {
        swarming: false,
      });
      service.platforms.set("keet", platform);
      await platform.start();
      const row = store.db
        .prepare("SELECT * FROM conversations WHERE account=? AND native=?")
        .get("keet", room)!;
      const scope = {
        account_id: "keet",
        conversation_id: String(row.id),
        native_id: room,
        type: "group" as const,
        senders: [],
      };
      let dispatches = 0;
      const signal = AbortSignal.timeout(10000);
      await platform.preflight(
        scope,
        [{ type: "text", text: "official fixture" }],
        null,
        signal,
      );
      const text = await platform.send(
        scope,
        { type: "text", text: "official fixture" },
        null,
        signal,
        0,
        () => dispatches++,
      );
      expect(text).toHaveLength(1);
      expect(dispatches).toBe(1);
      const pixel = new PNG({ width: 2, height: 2 });
      pixel.data.fill(255);
      const bytes = PNG.sync.write(pixel);
      const asset = await service.assets.ingest(
        new Response(new Uint8Array(bytes)).body,
        "image/png",
        "fixture.png",
        null,
        signal,
      );
      await platform.preflight(
        scope,
        [{ type: "image", asset_id: asset.asset_id }],
        null,
        signal,
      );
      const image = await platform.send(
        scope,
        { type: "image", asset_id: asset.asset_id },
        null,
        signal,
        0,
        () => dispatches++,
      );
      expect(image).toHaveLength(1);
      expect(dispatches).toBe(2);
      const mention = {
        type: "mention" as const,
        native_user_id: native.memberId,
      };
      await platform.preflight(scope, [mention], null, signal);
      expect(
        await platform.send(
          scope,
          mention,
          null,
          signal,
          0,
          () => dispatches++,
        ),
      ).toHaveLength(1);
      const reply = {
        native_message_id: text[0],
      } as import("../contracts/v1/index").MessageV1;
      await platform.preflight(
        scope,
        [{ type: "text", text: "reply fixture" }],
        reply,
        signal,
      );
      expect(
        await platform.send(
          scope,
          { type: "text", text: "reply fixture" },
          reply,
          signal,
          0,
          () => dispatches++,
        ),
      ).toHaveLength(1);
      const updated = await platform.saveProfile(
        {
          display_name: "Profile Fixture",
          avatar: { mime: "image/png", data_base64: bytes.toString("base64") },
        },
        signal,
      );
      expect(updated.avatar?.data_base64).toBeTruthy();
      const renamed = await platform.saveProfile(
        { display_name: "Renamed Fixture" },
        signal,
      );
      expect(renamed.display_name).toBe("Renamed Fixture");
      expect(renamed.avatar).toEqual(updated.avatar);
    } finally {
      await platform?.stop();
      await probe.stop();
      await store?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  45000,
);
