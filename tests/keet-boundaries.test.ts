import { test, expect } from "vitest";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  readFile,
  writeFile,
  rename,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { settingsFixture } from "./fixtures/settings";
import { until } from "./fixtures/state";
import { PNG } from "pngjs";
import { Application } from "../src/runtime";

const hash = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
test("Keet management and MCP use current membership and exact invitation target", async () => {
  const root = await mkdtemp(join(tmpdir(), "post-keet-boundary-"));
  const runtime = join(root, "runtime"),
    identity = join(root, "identity");
  await mkdir(join(runtime, "node_modules/bare-sidecar/prebuilds/linux-x64"), {
    recursive: true,
  });
  await mkdir(identity);
  const identity2 = join(root, "identity-2");
  await mkdir(identity2);
  await writeFile(
    join(identity2, "fixture.json"),
    JSON.stringify({
      member: "other-member",
      displayName: "Other",
      rooms: {},
      invites: [],
      links: {},
    }),
  );
  const launcher = join(
    runtime,
    "node_modules/bare-sidecar/prebuilds/linux-x64/bare",
  );
  await writeFile(
    launcher,
    "#!/bin/sh\nexec '" +
      process.execPath.replaceAll("'", "'\\''") +
      '\' "$@"\n',
    { mode: 0o700 },
  );
  const worker = resolve("tests/fixtures/keet-platform-worker.cjs");
  await symlink(worker, join(runtime, "core-worker.bundle"));
  const file = join(identity, "fixture.json");
  let native: any = {
    member: "member",
    displayName: "Old",
    autoJoin: true,
    rooms: {
      room: {
        type: "0",
        readable: true,
        writable: true,
        removed: false,
        name: "Fixture Room",
      },
    },
    invites: [
      { kind: "direct", room: "dm", peer: "peer", name: "Peer" },
      { kind: "group", room: "invited-room", peer: "inviter", name: "Inviter" },
      { kind: "group", room: "malformed", name: "Malformed" },
    ],
    history: {
      room: [
        {
          id: { deviceId: "old-device", seq: 1 },
          memberId: "peer",
          timestamp: 1,
          chat: {
            text: "@Post old",
            mentions: [{ memberId: "member", start: 0, length: 5 }],
          },
          files: [],
        },
      ],
    },
    links: {
      "link-a": { seed: "seed-a", name: "A", unrelatedRoom: "unrelated" },
      "link-b": { seed: "seed-b", name: "B", joinedRoom: "joined" },
    },
  };
  const save = async () => {
    await writeFile(file + ".test", JSON.stringify(native));
    await rename(file + ".test", file);
  };
  await save();
  const hashes = {
    bare: await hash(launcher),
    bundle: await hash(worker),
    addons: [] as string[],
  };
  let f: Awaited<ReturnType<typeof settingsFixture>> | undefined;
  try {
    f = await settingsFixture(
      false,
      2500,
      undefined,
      undefined,
      undefined,
      (config) => ({
        ...config,
        keet_runtime_dir: runtime,
        accounts: [
          ...config.accounts,
          {
            id: "keet-main",
            platform: "keet",
            native_id: "member",
            identity_dir: identity,
          },
          {
            id: "keet-other",
            platform: "keet",
            native_id: "other-member",
            identity_dir: identity2,
          },
        ],
        agents: [
          ...config.agents,
          {
            id: "second",
            receiver_url: config.agents[0]!.receiver_url,
            receiver_credential: "second-receiver",
          },
        ],
        bindings: [
          ...config.bindings.map((b) => ({
            ...b,
            account_ids: [...b.account_ids, "keet-main"],
          })),
          {
            id: "second-binding",
            agent_id: "second",
            account_ids: ["keet-other"],
            enabled: true,
            scopes: [],
            wake: { direct: true, mention: true, reply: true, aliases: [] },
          },
        ],
      }),
      { keet: { hashes, swarming: false } },
    );
    expect(
      (await f.request("keet/profile", { account_id: "keet-main" })).status,
    ).toBe(401);
    await f.login();
    const settings = await (await f.request("settings")).json();
    const account = settings.accounts.find((a: any) => a.id === "keet-main");
    expect(account).not.toHaveProperty("identity_dir");
    expect(account).not.toHaveProperty("native_id");
    native = JSON.parse(await readFile(file, "utf8"));
    native.displayName = null;
    await save();
    const avatar = new PNG({ width: 2, height: 2 });
    avatar.data.fill(255);
    const avatarOnly = await f.request("keet/profile/save", {
      account_id: "keet-main",
      avatar: {
        mime: "image/png",
        data_base64: PNG.sync.write(avatar).toString("base64"),
      },
    });
    expect(avatarOnly.status).toBe(400);
    native = JSON.parse(await readFile(file, "utf8"));
    expect(native.displayName).toBeNull();
    native.displayName = "Old";
    await save();
    expect(
      (
        await f.request(
          "keet/profile/save",
          { account_id: "keet-main", display_name: "New" },
          { "X-Post-CSRF": "invalid" },
        )
      ).status,
    ).toBe(401);
    expect(
      await (
        await f.request("keet/profile/save", {
          account_id: "keet-main",
          display_name: "New",
        })
      ).json(),
    ).toEqual({ display_name: "New", avatar: null });
    // A valid PNG at the advertised 8 MiB limit also exercises the full HTTP body.
    // Sharp accepts these test-owned trailing bytes; they trigger the old regex's stack overflow.
    const png = PNG.sync.write(avatar);
    const largePng = Buffer.concat([
      png,
      Buffer.alloc(8 * 1024 * 1024 - png.length, 11),
    ]);
    const largeProfileResponse = await f.request("keet/profile/save", {
      account_id: "keet-main",
      avatar: { mime: "image/png", data_base64: largePng.toString("base64") },
    });
    expect(largeProfileResponse.status).toBe(200);
    const largeProfile = await largeProfileResponse.json();
    expect(largeProfile).toMatchObject({
      display_name: "New",
      avatar: { mime: "image/png", data_base64: expect.any(String) },
    });
    expect(
      await (
        await f.request("keet/profile", { account_id: "keet-main" })
      ).json(),
    ).toEqual(largeProfile);
    const canonical = png.toString("base64");
    const lastDataIndex = canonical.indexOf("=") - 1;
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const noncanonical =
      canonical.slice(0, lastDataIndex) +
      alphabet[alphabet.indexOf(canonical[lastDataIndex]!) + 1] +
      canonical.slice(lastDataIndex + 1);
    expect(Buffer.from(noncanonical, "base64")).toEqual(png);
    for (const malformed of [
      canonical.slice(0, 4) + "!" + canonical.slice(4),
      canonical + "\n",
      canonical.replace(/=+$/, ""),
      noncanonical,
    ]) {
      expect(Buffer.from(malformed, "base64")).toEqual(png);
      expect(
        (
          await f.request("keet/profile/save", {
            account_id: "keet-main",
            avatar: { mime: "image/png", data_base64: malformed },
          })
        ).status,
      ).toBe(400);
    }
    // One extra decoded byte has the same Base64 length at this boundary.
    const tooLarge = Buffer.concat([largePng, Buffer.from([11])]);
    expect(
      (
        await f.request("keet/profile/save", {
          account_id: "keet-main",
          avatar: {
            mime: "image/png",
            data_base64: tooLarge.toString("base64"),
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.request("keet/profile/save", {
          account_id: "keet-main",
          avatar: { mime: "image/gif", data_base64: canonical },
        })
      ).status,
    ).toBe(400);
    expect(
      await (
        await f.request("keet/profile", { account_id: "keet-main" })
      ).json(),
    ).toEqual(largeProfile);
    expect(
      (
        await (
          await f.request("keet/directory", { account_id: "keet-main" })
        ).json()
      ).invites,
    ).toEqual([
      {
        kind: "group",
        room_id: "invited-room",
        peer_id: "inviter",
        name: "Inviter",
      },
      { kind: "direct", room_id: "dm", peer_id: "peer", name: "Peer" },
    ]);
    expect(f.receiver.attempts).toHaveLength(0);
    expect(
      (
        await f.request("keet/invites/accept", {
          account_id: "keet-main",
          kind: "group",
          room_id: "invited-room",
          peer_id: "wrong",
        })
      ).status,
    ).toBe(409);
    expect(
      await (
        await f.request("keet/invites/accept", {
          account_id: "keet-main",
          kind: "group",
          room_id: "invited-room",
          peer_id: "inviter",
        })
      ).json(),
    ).toEqual({ status: "joined" });
    const inspect = async (link: string) =>
      (
        await f!.request("keet/link/inspect", {
          account_id: "keet-main",
          link: `keet://chat/${link}`,
        })
      ).json();
    const a = await inspect("link-a");
    expect(a).toEqual({
      target_id: expect.any(String),
      name: "A",
      room_id: null,
    });
    native = JSON.parse(await readFile(file, "utf8"));
    native.fail = 28;
    await save();
    expect(
      await (
        await f.request("keet/link/join", {
          account_id: "keet-main",
          link: "keet://chat/link-a",
          target_id: a.target_id,
        })
      ).json(),
    ).toEqual({ status: "unknown" });
    native = JSON.parse(await readFile(file, "utf8"));
    delete native.fail;
    await save();
    expect((await inspect("link-a")).room_id).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 100));
    native = JSON.parse(await readFile(file, "utf8"));
    expect(native.joins ?? 0).toBe(0);

    expect(
      (
        await f.request("keet/link/join", {
          account_id: "keet-main",
          link: "keet://chat/link-a",
          target_id: "wrong",
        })
      ).status,
    ).toBe(409);
    expect(
      await (
        await f.request("keet/link/join", {
          account_id: "keet-main",
          link: "keet://chat/link-a",
          target_id: a.target_id,
        })
      ).json(),
    ).toEqual({ status: "pending" });
    expect((await inspect("link-a")).room_id).toBeNull();
    const b = await inspect("link-b");
    expect(
      await (
        await f.request("keet/link/join", {
          account_id: "keet-main",
          link: "keet://chat/link-b",
          target_id: b.target_id,
        })
      ).json(),
    ).toEqual({ status: "joined" });
    expect((await inspect("link-b")).room_id).toBe("joined");
    native = JSON.parse(await readFile(file, "utf8"));
    expect(native.joins).toBe(2);
    expect(
      await (
        await f.request("keet/link/join", {
          account_id: "keet-main",
          link: "keet://chat/link-b",
          target_id: b.target_id,
        })
      ).json(),
    ).toEqual({ status: "joined" });
    native = JSON.parse(await readFile(file, "utf8"));
    expect(native.joins).toBe(2);
    native = JSON.parse(await readFile(file, "utf8"));
    native.fail = 160;
    await save();
    expect(
      await (
        await f.request("keet/invites/accept", {
          account_id: "keet-main",
          kind: "direct",
          room_id: "dm",
          peer_id: "peer",
        })
      ).json(),
    ).toEqual({ status: "unknown" });
    native = JSON.parse(await readFile(file, "utf8"));
    delete native.fail;
    await save();
    expect(
      (
        await (
          await f.request("keet/directory", { account_id: "keet-main" })
        ).json()
      ).invites.some((i: any) => i.room_id === "dm"),
    ).toBe(true);
    expect(
      await (
        await f.request("keet/invites/accept", {
          account_id: "keet-main",
          kind: "direct",
          room_id: "dm",
          peer_id: "peer",
        })
      ).json(),
    ).toEqual({ status: "joined" });
    const machine = async (
      name: string,
      args: unknown,
      token = f!.state.token,
    ) => {
      const response = await fetch(f!.app.app.http!.url + "/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      return (await response.json()).result;
    };
    const secondToken = (
      await (
        await f.request("token", { agent_id: "second", action: "issue" })
      ).json()
    ).token;
    const firstAccounts = await machine("list_accounts", {});
    const secondAccounts = await machine("list_accounts", {}, secondToken);
    expect(
      firstAccounts.structuredContent.items.some(
        (a: any) => a.account_id === "keet-other",
      ),
    ).toBe(false);
    expect(
      secondAccounts.structuredContent.items.map((a: any) => a.account_id),
    ).toEqual(["keet-other"]);
    const secondFile = join(identity2, "fixture.json");
    const secondNative = JSON.parse(await readFile(secondFile, "utf8"));
    const saveSecond = async () => {
      await writeFile(secondFile + ".test", JSON.stringify(secondNative));
      await rename(secondFile + ".test", secondFile);
    };
    const uploadSecond = () =>
      fetch(f!.app.app.http!.url + "/assets", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + secondToken,
          "Content-Type": "application/octet-stream",
        },
        body: "second account asset",
      });
    const readSecond = (id: string) =>
      fetch(f!.app.app.http!.url + "/assets/" + id, {
        headers: { Authorization: "Bearer " + secondToken },
      });
    // Listing the bound account does not grant uploads in an empty directory.
    expect((await uploadSecond()).status).toBe(403);
    const secondBinding = f.app.config.bindings.find(
      (b) => b.id === "second-binding",
    )!;
    secondBinding.scopes.push({
      account_id: "keet-other",
      conversation_id: "forged",
      native_id: "forged",
      type: "group",
      senders: [],
    });
    try {
      expect((await uploadSecond()).status).toBe(403);
    } finally {
      secondBinding.scopes.pop();
    }
    secondNative.rooms["second-dm"] = {
      type: "2",
      readable: true,
      writable: true,
      removed: false,
      peer: "second-peer",
      name: "Second peer",
    };
    secondNative.invites = [
      { kind: "direct", room: "second-dm", peer: "second-peer" },
    ];
    await saveSecond();
    expect((await uploadSecond()).status).toBe(403);
    secondNative.invites = [];
    await saveSecond();
    const secondUpload = await uploadSecond();
    expect(secondUpload.status).toBe(201);
    const secondAsset = (await secondUpload.json()).asset_id;
    const secondRead = await readSecond(secondAsset);
    expect(secondRead.status).toBe(200);
    expect(await secondRead.text()).toBe("second account asset");
    await f.app.app.service!.observe("keet-other", {
      native_id: JSON.stringify(["second-device", 1]),
      conversation_native_id: "second-dm",
      conversation_type: "direct",
      sender: "second-peer",
      timestamp: Date.now(),
      content: [{ type: "text", text: "observed from the accepted peer" }],
      assets: [],
      mentions: [],
      self_mentioned: false,
      catchup: true,
    });
    secondNative.rooms["second-dm"].peer = "different-peer";
    await saveSecond();
    expect((await uploadSecond()).status).toBe(403);
    expect((await readSecond(secondAsset)).status).toBe(404);
    secondNative.rooms["second-dm"].peer = "second-peer";
    await saveSecond();
    expect((await readSecond(secondAsset)).status).toBe(200);
    secondNative.fail = 43;
    await saveSecond();
    expect((await uploadSecond()).status).toBe(503);
    expect((await readSecond(secondAsset)).status).toBe(503);
    native = JSON.parse(await readFile(file, "utf8"));
    native.fail = 43;
    await save();
    const scopedUpload = await fetch(f.app.app.http!.url + "/assets", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + f.state.token,
        "Content-Type": "application/octet-stream",
      },
      body: "existing non-Keet grant",
    });
    expect(scopedUpload.status).toBe(201);
    native = JSON.parse(await readFile(file, "utf8"));
    delete native.fail;
    await save();
    delete secondNative.fail;
    secondNative.rooms["second-dm"].removed = true;
    await saveSecond();
    expect((await uploadSecond()).status).toBe(403);
    expect((await readSecond(secondAsset)).status).toBe(404);
    expect(
      await machine(
        "list_conversations",
        { account_id: "keet-main" },
        secondToken,
      ),
    ).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "not_found" } },
    });
    const listing = await machine("list_conversations", {
      account_id: "keet-main",
    });
    expect(
      listing.structuredContent.items.some(
        (i: any) => i.name === "Fixture Room",
      ),
    ).toBe(true);
    native = JSON.parse(await readFile(file, "utf8"));
    native.history = {
      room: [
        {
          id: { deviceId: "peer-device", seq: 1 },
          memberId: "peer",
          member: { displayName: "Peer" },
          timestamp: Date.now(),
          chat: {
            text: "@Post hello",
            mentions: [{ memberId: "member", start: 0, length: 5 }],
          },
          files: [],
        },
      ],
    };
    await save();
    await until(() => f!.receiver.attempts.length > 0, 5000);
    const event = JSON.parse(f.receiver.attempts[0]);
    expect(event.message.platform).toBe("keet");
    expect(event.wake.reason).toBe("mentioned");
    native = JSON.parse(await readFile(file, "utf8"));
    native.history.room[0].chat = {
      text: "edited fixture",
      edited: true,
      mentions: [],
    };
    native.history.room[0].editedAt = Date.now();
    await save();
    const readHistory = () =>
      machine("read_messages", {
        account_id: "keet-main",
        conversation_name: "Fixture Room",
      });
    await until(
      async () =>
        (await readHistory()).structuredContent.items.some(
          (m: any) => m.mutation === "edit",
        ),
      5000,
    );
    native = JSON.parse(await readFile(file, "utf8"));
    native.history.room[0].deleted = true;
    native.history.room[0].chat = null;
    await save();
    await until(
      async () =>
        (await readHistory()).structuredContent.items.some(
          (m: any) => m.mutation === "retraction",
        ),
      5000,
    );
    expect(f.receiver.attempts).toHaveLength(1);
    const sent = await machine("send_message", {
      account_id: "keet-main",
      conversation_name: "Fixture Room",
      request_id: "send-one",
      content: [{ type: "text", text: "outbound fixture" }],
    });
    expect(sent.structuredContent).toMatchObject({
      status: "sent",
      parts: [{ status: "sent", stored: true }],
    });
    const repeat = await machine("send_message", {
      account_id: "keet-main",
      conversation_name: "Fixture Room",
      request_id: "send-one",
      content: [{ type: "text", text: "outbound fixture" }],
    });
    expect(repeat.structuredContent).toEqual(sent.structuredContent);
    native = JSON.parse(await readFile(file, "utf8"));
    expect(native.sent).toHaveLength(1);
    const pixel = new PNG({ width: 2, height: 2 });
    pixel.data.fill(255);
    const upload = await fetch(f.app.app.http!.url + "/assets", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + f.state.token,
        "Content-Type": "image/png",
      },
      body: new Uint8Array(PNG.sync.write(pixel)),
    });
    expect(upload.status).toBe(201);
    const uploaded = await upload.json();
    const imageSend = await machine("send_message", {
      account_id: "keet-main",
      conversation_name: "Fixture Room",
      request_id: "send-image",
      content: [{ type: "image", asset_id: uploaded.asset_id }],
    });
    expect(imageSend.structuredContent).toMatchObject({
      status: "sent",
      parts: [{ status: "sent", stored: true }],
    });
    native = JSON.parse(await readFile(file, "utf8"));
    expect(native.sent).toHaveLength(2);
    const confirmed = JSON.parse(
      imageSend.structuredContent.parts[0].native_message_ids[0],
    );
    expect(confirmed[1]).toBe(native.sent[1].id.seq);
    native.dropSend = true;
    await save();
    const uncertainArgs = {
      account_id: "keet-main",
      conversation_name: "Fixture Room",
      request_id: "uncertain",
      content: [{ type: "text", text: "uncertain fixture" }],
    };
    const uncertain = await machine("send_message", uncertainArgs);
    expect(uncertain.structuredContent.status).toBe("unknown");
    native = JSON.parse(await readFile(file, "utf8"));
    expect(native.sent).toHaveLength(3);
    native.dropSend = false;
    await save();
    await f.app.app.stop(false);
    f.app.app = new Application(f.app.config, f.app.fixture, f.app.store);
    await f.app.app.start();
    await until(
      () => f!.app.app.service?.platforms.get("keet-main")?.ready,
      5000,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(f.receiver.attempts).toHaveLength(1);
    const reconciliation = await machine("send_message", uncertainArgs);
    expect(reconciliation.structuredContent.status).toBe("unknown");
    native = JSON.parse(await readFile(file, "utf8"));
    expect(native.sent).toHaveLength(3);
    await f.app.app.service!.observe("keet-main", {
      native_id: "peer-device:old",
      conversation_native_id: "dm",
      conversation_type: "direct",
      sender: "peer",
      timestamp: Date.now(),
      content: [{ type: "text", text: "old peer" }],
      assets: [],
      mentions: [],
      self_mentioned: false,
      catchup: true,
    });
    native.rooms.dm.peer = "other-peer";
    await save();
    const stalePeer = await machine("get_conversation", {
      account_id: "keet-main",
      conversation_name: "Peer",
    });
    expect(stalePeer).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "not_found" } },
    });
    native.rooms.dm.peer = "peer";
    native.invites.push({
      kind: "direct",
      room: "dm",
      peer: "peer",
      name: "Peer",
    });
    await save();
    const pendingDm = await machine("get_conversation", {
      account_id: "keet-main",
      conversation_name: "Peer",
    });
    expect(pendingDm).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "not_found" } },
    });
    native.invites = [];
    native.fail = 39;
    await save();
    const attempts = f.receiver.attempts.length;
    f.app.store.db
      .prepare("UPDATE deliveries SET state='pending',due=0 WHERE id=?")
      .run(event.delivery_id);
    await f.app.app.service!.dispatch(f.app.config.bindings[0]);
    expect(
      f.app.store.db
        .prepare("SELECT state FROM deliveries WHERE id=?")
        .get(event.delivery_id)?.state,
    ).toBe("pending");
    expect(f.receiver.attempts).toHaveLength(attempts);
    delete native.fail;
    native.rooms.room.removed = true;
    await save();
    f.app.store.db
      .prepare("UPDATE deliveries SET due=0 WHERE id=?")
      .run(event.delivery_id);
    await f.app.app.service!.dispatch(f.app.config.bindings[0]);
    expect(
      f.app.store.db
        .prepare("SELECT state FROM deliveries WHERE id=?")
        .get(event.delivery_id)?.state,
    ).toBe("cancelled");
    const revoked = await machine("get_conversation", {
      account_id: "keet-main",
      conversation_name: "Fixture Room",
    });
    expect(revoked).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "not_found" } },
    });
    const beforeSave = await f.app.view();
    const joinedRow = f.app.store.db
      .prepare("SELECT id FROM conversations WHERE account=? AND native=?")
      .get("keet-main", "joined")!;
    const saved = await f.apply("settings", {
      version: beforeSave.version,
      accounts: beforeSave.accounts.map(
        ({ hasCredential, ready, ...a }: any) => a,
      ),
      agents: beforeSave.agents.map(
        ({ hasCredential, hasToken, ...a }: any) => a,
      ),
      bindings: beforeSave.bindings.map((b: any) => ({
        ...b,
        enabled: b.agent_id === "cfl" ? false : b.enabled,
        scopes: b.scopes.map(({ name, ...scope }: any) => scope),
      })),
      conversation_names: [
        {
          account_id: "keet-main",
          conversation_id: joinedRow.id,
          name: "Renamed joined",
        },
      ],
      secrets: [],
    });
    expect(saved.ok).toBe(true);
    expect(
      f.app.config.accounts.find((a) => a.id === "keet-main"),
    ).toMatchObject({ identity_dir: identity, native_id: "member" });
    await until(
      () => f!.app.app.service?.platforms.get("keet-main")?.ready,
      5000,
    );
    expect(
      await (
        await f.request("keet/profile", { account_id: "keet-main" })
      ).json(),
    ).toEqual(largeProfile);
    const disabledDirectory = await (
      await f.request("keet/directory", { account_id: "keet-main" })
    ).json();
    expect(
      disabledDirectory.items.some((i: any) => i.name === "Renamed joined"),
    ).toBe(true);
    expect(await f.app.app.service!.call("cfl", "list_accounts", {})).toEqual({
      items: [],
    });
  } finally {
    await f?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
