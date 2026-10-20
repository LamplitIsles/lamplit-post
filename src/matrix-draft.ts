import { MatrixClient } from "matrix-js-sdk";
import { boundedBytes } from "./io";
import { need } from "./errors";
import { opaque, type Store } from "./store";
import type { AccountConfig } from "./config";

/** Read-only request-scoped SDK: no startClient, sync, identity pin or vault write. */
export async function verifyMatrix(
  account: AccountConfig,
  token: string,
  store: Store,
  parent: AbortSignal,
  resolveIdentity: (verified: string) => AccountConfig,
) {
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  const jobs = new Set<Promise<unknown>>();
  const quiet: any = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    getChild() {
      return this;
    },
  };
  const client = new MatrixClient({
    baseUrl: account.homeserver!,
    accessToken: token,
    userId: account.native_id,
    useAuthorizationHeader: true,
    logger: quiet,
    fetchFn: ((input: any, init: any) => {
      const work = (async () => {
        signal.throwIfAborted();
        const response = await fetch(input, {
          ...init,
          redirect: "error",
          signal: AbortSignal.any([
            signal,
            ...(init?.signal ? [init.signal] : []),
          ]),
        });
        return new Response(await boundedBytes(response, signal), {
          status: response.status,
          headers: response.headers,
        });
      })();
      jobs.add(work);
      void work.finally(() => jobs.delete(work)).catch(() => {});
      return work;
    }) as typeof fetch,
  });
  try {
    const identity = await client.whoami();
    need(identity.user_id === account.native_id, "conflict");
    account = resolveIdentity(identity.user_id);
    const rooms = await client.getJoinedRooms();
    const items = [];
    for (const native_id of rooms.joined_rooms.slice(0, 100)) {
      need(
        typeof native_id === "string" && native_id.length <= 256,
        "unavailable",
      );
      const state = await client.roomState(native_id);
      const pin = store.db
        .prepare(
          "SELECT id,type FROM conversations WHERE account=? AND native=?",
        )
        .get(account.id, native_id);
      const name = state.find((e: any) => e.type === "m.room.name")?.content
        ?.name;
      items.push({
        native_id,
        conversation_id: pin?.id ?? opaque("c"),
        type: pin?.type ?? "group",
        name:
          typeof name === "string" && name.trim()
            ? name.trim().slice(0, 256)
            : native_id,
        encrypted: state.some((e: any) => e.type === "m.room.encryption"),
        source: "platform",
      });
    }
    return {
      account,
      items,
      source: "platform",
      complete: false,
      verified: true,
    };
  } finally {
    controller.abort();
    client.stopClient();
    client.removeAllListeners();
    await Promise.allSettled([...jobs]);
  }
}
