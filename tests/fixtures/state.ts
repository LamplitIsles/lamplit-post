import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigSchema } from "../../src/config";
import { Store } from "../../src/store";
export async function stateFixture(
  homeserver: string,
  receiver: string,
  timeout = 1500,
) {
  const dir = await mkdtemp(join(tmpdir(), "post-state-"));
  const key = join(dir, "master.key");
  await writeFile(key, Buffer.alloc(32, 7), { mode: 0o600 });
  const config = ConfigSchema.parse({
    data_dir: join(dir, "data"),
    master_key_file: key,
    port: 0,
    timeout_ms: timeout,
    accounts: [
      {
        id: "qq-main",
        platform: "qq",
        native_id: "qq-app",
        credential: "qq-secret",
      },
      {
        id: "matrix-main",
        platform: "matrix",
        native_id: "@post:fixture",
        credential: "matrix-secret",
        homeserver,
      },
    ],
    agents: [
      {
        id: "cfl",
        receiver_url: receiver,
        receiver_credential: "receiver-secret",
      },
    ],
    bindings: [
      {
        id: "cfl-binding",
        agent_id: "cfl",
        account_ids: ["qq-main", "matrix-main"],
        scopes: [
          {
            account_id: "qq-main",
            conversation_id: "qq-group",
            native_id: "qq-group",
            type: "group",
          },
          {
            account_id: "qq-main",
            conversation_id: "qq-dm",
            native_id: "qq-owner",
            type: "direct",
            senders: ["qq-owner"],
          },
          {
            account_id: "matrix-main",
            conversation_id: "matrix-room",
            native_id: "!room:fixture",
            type: "group",
          },
          {
            account_id: "matrix-main",
            conversation_id: "matrix-dm",
            native_id: "!dm:fixture",
            type: "direct",
            senders: ["@owner:fixture"],
          },
        ],
        wake: { direct: true, mention: true, reply: true, aliases: ["Post,"] },
      },
    ],
  });
  const store = await Store.open(config);
  await store.putSecret(
    "qq-secret",
    "qq-main",
    "platform",
    "test-qq-platform-secret",
  );
  await store.putSecret(
    "matrix-secret",
    "matrix-main",
    "platform",
    "test-matrix-platform-secret",
  );
  await store.putSecret("receiver-secret", "cfl", "receiver", "test-receiver");
  const token = await store.issue("cfl");
  await store.close();
  return {
    dir,
    config,
    token,
    async close() {
      await rm(dir, { recursive: true });
    },
  };
}
export async function until(
  predicate: () => unknown | Promise<unknown>,
  timeout = 3000,
) {
  const end = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error("Condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function count(db: any, table: string) {
  if (table === "inbox")
    return db.prepare("SELECT count(*) n FROM inbox").get().n as number;
  if (
    ![
      "vault",
      "tokens",
      "identities",
      "conversations",
      "messages",
      "assets",
      "message_assets",
      "deliveries",
      "sends",
      "reply_sequences",
      "gaps",
    ].includes(table)
  )
    throw new Error("Unknown fixture table");
  return db.prepare("SELECT count(*) n FROM " + table).get().n as number;
}
