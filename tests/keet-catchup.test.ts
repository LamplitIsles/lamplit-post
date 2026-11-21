import { expect, test } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { ConfigSchema } from "../src/config";
import { Application } from "../src/runtime";
import { Store } from "../src/store";
import { consumerFixture } from "./fixtures/consumer";
import { until } from "./fixtures/state";

const origin = Math.floor(performance.timeOrigin);
const record = (timestamp: number, seq: number) => ({
  id: { deviceId: "fixture-device", seq },
  memberId: "peer",
  timestamp,
  chat: { text: `fixture ${seq}`, mentions: [] },
  files: [],
});
const hash = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

test.each(["late history", "first frame and resubscription"] as const)(
  "Keet process-start catchup: %s",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "post-keet-catchup-"));
    const receiver = await consumerFixture();
    let app: Application | undefined;
    try {
      const runtime = join(root, "runtime"),
        identity = join(root, "identity");
      const bare = join(
        runtime,
        "node_modules/bare-sidecar/prebuilds/linux-x64/bare",
      );
      const worker = resolve("tests/fixtures/keet-platform-worker.cjs");
      await mkdir(join(bare, ".."), { recursive: true });
      await mkdir(identity);
      await writeFile(join(identity, "trace-frames"), "");
      await writeFile(
        bare,
        "#!/bin/sh\nexec '" +
          process.execPath.replaceAll("'", "'\\''") +
          '\' "$@"\n',
        { mode: 0o700 },
      );
      await symlink(worker, join(runtime, "core-worker.bundle"));
      const data = {
        member: "fixture-self",
        invites: [],
        links: {},
        rooms: {
          room: {
            type: "2",
            name: "Fixture DM",
            peer: "peer",
            readable: true,
            writable: true,
            removed: false,
          },
        },
        history: {
          room:
            mode === "late history"
              ? []
              : [record(origin - 1, 1), record(origin, 2)],
        },
      };
      const save = async () => {
        const temp = join(identity, "fixture.json.tmp");
        await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
        await rename(temp, join(identity, "fixture.json"));
      };
      await save();
      const cfg = ConfigSchema.parse({
        data_dir: join(root, "data"),
        master_key_file: join(root, "master.key"),
        keet_runtime_dir: runtime,
        port: 0,
        timeout_ms: 2500,
        accounts: [
          {
            id: "keet",
            platform: "keet",
            native_id: "fixture-self",
            identity_dir: identity,
          },
        ],
        agents: [
          {
            id: "cfl",
            receiver_url: receiver.url,
            receiver_credential: "cfl-receiver",
          },
        ],
        bindings: [
          {
            id: "agent-keet",
            agent_id: "cfl",
            account_ids: ["keet"],
            scopes: [],
            wake: { direct: true, mention: false, reply: false, aliases: [] },
          },
        ],
      });
      const store = await Store.open(cfg);
      try {
        store.putSecret("cfl-receiver", "cfl", "receiver", "test-receiver");
        await store.issue("cfl");
      } finally {
        await store.close();
      }
      const options = {
        keet: {
          swarming: false as const,
          hashes: {
            bare: await hash(bare),
            bundle: await hash(worker),
            addons: [],
          },
        },
      };
      const start = async () => {
        app = new Application(cfg, options);
        await app.start();
        await until(() => app!.service!.platforms.get("keet")?.ready);
      };
      const delivered = () =>
        receiver.db
          .prepare(
            "SELECT json_extract(body,'$.message.timestamp') AS ts FROM inbox ORDER BY rowid",
          )
          .all()
          .map((row) => Number(row.ts));
      const attempts = () =>
        receiver.attempts.map((body) => JSON.parse(body).message.timestamp);
      const stored = () =>
        app!
          .store!.db.prepare(
            "SELECT json_extract(body,'$.timestamp') AS ts FROM messages ORDER BY json_extract(body,'$.timestamp')",
          )
          .all()
          .map((row) => Number(row.ts));
      const history = async () =>
        (
          await app!.service!.call("cfl", "read_messages", {
            account_id: "keet",
            conversation_name: "Fixture DM",
          })
        ).items
          .map((message: { timestamp: number }) => message.timestamp)
          .sort((a: number, b: number) => a - b);
      await start();
      if (mode === "late history") {
        // Wait for the empty snapshot to be processed before delivering a mixed frame.
        await until(
          async () =>
            (
              await readFile(join(identity, "frames.jsonl"), "utf8").catch(
                () => "",
              )
            ).trim().length > 0,
        );
        data.history.room = [record(origin - 2, 1), record(origin + 1, 2)];
        await save();
        await until(() => delivered().includes(origin + 1));
        expect(stored()).toEqual([origin - 2, origin + 1]);
        expect(await history()).toEqual([origin - 2, origin + 1]);
        expect(delivered()).toEqual([origin + 1]);
        expect(attempts()).toEqual([origin + 1]);
      } else {
        await until(() => delivered().includes(origin));
        expect(stored()).toEqual([origin - 1, origin]);
        expect(await history()).toEqual([origin - 1, origin]);
        expect(delivered()).toEqual([origin]);
        expect(attempts()).toEqual([origin]);
        // This message was sent while Post was running, before the new subscription.
        const duringProcess = Date.now();
        await app!.stop();
        app = undefined;
        data.history.room = [
          record(origin - 1, 1),
          record(origin, 2),
          record(duringProcess, 3),
        ];
        await save();
        await start();
        await until(() => delivered().includes(duringProcess));
        // A subsequent positive barrier ensures repeated snapshots cannot hide duplicate delivery.
        data.history.room = [
          ...data.history.room,
          record(duringProcess + 1, 4),
        ];
        await save();
        await until(() => delivered().includes(duringProcess + 1));
        expect(delivered()).toEqual([origin, duringProcess, duringProcess + 1]);
        expect(attempts()).toEqual([origin, duringProcess, duringProcess + 1]);
        expect(stored()).toEqual([
          origin - 1,
          origin,
          duringProcess,
          duringProcess + 1,
        ]);
        // Remove and re-add the room while the same adapter remains running.
        const closedCount = async () =>
          (await readFile(join(identity, "frames.jsonl"), "utf8")).split(
            "closed\n",
          ).length - 1;
        const previousClosures = await closedCount();
        const room = data.rooms.room;
        data.rooms = {} as typeof data.rooms;
        await save();
        await until(async () => (await closedCount()) > previousClosures, 7000);
        const beforeResubscribe = Date.now();
        data.history.room = [
          ...data.history.room,
          record(beforeResubscribe, 5),
        ];
        data.rooms = { room };
        await save();
        await until(() => delivered().includes(beforeResubscribe), 7000);
        data.history.room = [
          ...data.history.room,
          record(beforeResubscribe + 1, 6),
        ];
        await save();
        await until(() => delivered().includes(beforeResubscribe + 1));
        expect(delivered()).toEqual([
          origin,
          duringProcess,
          duringProcess + 1,
          beforeResubscribe,
          beforeResubscribe + 1,
        ]);
        expect(attempts()).toEqual([
          origin,
          duringProcess,
          duringProcess + 1,
          beforeResubscribe,
          beforeResubscribe + 1,
        ]);
      }
    } finally {
      await app?.stop();
      await receiver.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
