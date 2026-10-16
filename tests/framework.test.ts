import { test, expect } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config";
import { Store } from "../src/store";
test("native SQLite vault and key reopen under exclusive owned state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "post-framework-"));
  const config = ConfigSchema.parse({
    data_dir: join(dir, "data"),
    master_key_file: join(dir, "keys", "master"),
    accounts: [
      { id: "qq", platform: "qq", credential: "qq-secret", native_id: "app" },
    ],
    bindings: [
      {
        id: "binding",
        agent_id: "agent",
        receiver_url: "http://127.0.0.1:1",
        receiver_credential: "receiver",
        scopes: [
          {
            account_id: "qq",
            conversation_id: "group",
            native_id: "native",
            type: "group",
          },
        ],
        wake: {},
      },
    ],
  });
  let store: Store | undefined;
  try {
    store = await Store.open(config);
    const key = await readFile(config.master_key_file);
    await expect(Store.open(config)).rejects.toBeDefined();
    await store.putSecret("qq-secret", "qq", "platform", "owned-secret");
    const token = await store.issue("agent");
    expect(store.authenticate(token)).toBe("agent");

    expect(await store.secret("qq-secret", "qq", "platform")).toBe(
      "owned-secret",
    );
    expect(
      (await stat(join(config.data_dir, "post.sqlite"))).mode & 0o077,
    ).toBe(0);
    await store.close();
    expect(store.authenticate(token)).toBeUndefined();
    store = await Store.open(config);
    expect(await readFile(config.master_key_file)).toEqual(key);
    expect(await store.secret("qq-secret", "qq", "platform")).toBe(
      "owned-secret",
    );
    expect(store.authenticate(token)).toBe("agent");
    await store.revoke("agent");
    expect(store.authenticate(token)).toBeUndefined();
  } finally {
    await store?.close();
    await rm(dir, { recursive: true });
  }
});
