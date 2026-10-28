import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { Admin } from "./admin";
import { Settings } from "./settings";
import { Fault, need } from "./errors";
import { isShareURL } from "./config";
import { MatrixUserBot } from "./matrix";
import { QQPlatform } from "./host";
import QRCode from "qrcode";
import { ConfigSchema } from "./config";
import { verifyMatrix } from "./matrix-draft";
import { authorizeQQ } from "./qq-connect";
import type {
  startQrConnect,
  QrConnectCredentials,
} from "@tencent-connect/qqbot-connector";
import { randomBytes } from "node:crypto";
import { ensureConversationName } from "./conversation-name";
class Unauthorized extends Error {}
function auth(value: unknown): asserts value {
  if (!value) throw new Unauthorized();
}
export function shareURL(value: string) {
  need(isShareURL(value), "invalid_request");
  return new URL(value).href;
}
async function body(req: IncomingMessage) {
  need(req.headers["content-type"] === "application/json", "invalid_request");
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    need(size <= 131072, "invalid_request");
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString());
}
export async function serveSettings(
  settings: Settings,
  root = resolve(__dirname, "web"),
  connector?: typeof startQrConnect,
  qrLifetime = 120000,
) {
  const cfg = settings.config.settings!;
  const origin = new URL(cfg.origin);
  need(
    origin.origin === cfg.origin &&
      (origin.protocol === "https:" ||
        (origin.protocol === "http:" && origin.hostname === "127.0.0.1")),
    "invalid_request",
  );
  const admin = new Admin();
  await admin.open(cfg.admin_file);
  const jobs = new Set<Promise<void>>();
  let closing = false;
  let stopping: Promise<void> | undefined;
  type QQDraft = {
    id: string;
    owner: string;
    expires: number;
    state: string;
    image: string | null;
    native_id: string | null;
    imageVersion: number;
    account_id?: string;
    credential?: QrConnectCredentials;
    controller: AbortController;
    flow: ReturnType<typeof authorizeQQ>;
    timer: ReturnType<typeof setTimeout>;
  };
  let qq: QQDraft | undefined;
  let qrMutating = false;
  async function cancelQQ(state = "cancelled") {
    const draft = qq;
    if (!draft) return;
    draft.state = state;
    draft.credential = undefined;
    draft.image = null;
    clearTimeout(draft.timer);
    draft.controller.abort();
    draft.flow.cancel();
    await draft.flow.done;
    draft.flow = { cancel() {}, done: Promise.resolve(null) };
  }
  const publicQQ = () =>
    qq && {
      id: qq.id,
      expires: qq.expires,
      state: qq.state,
      image: qq.image,
      native_id: qq.native_id,
      account_id: qq.account_id,
    };
  const server = createServer((req, res) => {
    req.socket.setTimeout(10000);
    const controller = new AbortController();
    const cancelled = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once("close", cancelled);
    req.once("aborted", cancelled);
    const work = (async () => {
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      try {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        );
        auth(!closing && req.headers.host === origin.host);
        if (req.headers.origin) auth(req.headers.origin === origin.origin);
        const path = new URL(req.url!, origin).pathname;
        const method = req.method;
        if (path.startsWith("/api/")) {
          const mutation = method !== "GET";
          if (mutation) auth(req.headers.origin === origin.origin);
          if (path === "/api/login" && method === "POST") {
            const input = await body(req);
            need(
              typeof input.password === "string" &&
                input.password.length <= 1024,
              "invalid_request",
            );
            const token = await admin.login(cfg.admin_file, input.password);
            auth(token);
            res.setHeader(
              "Set-Cookie",
              `post_admin=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=28800${origin.protocol === "https:" ? "; Secure" : ""}`,
            );
            return send(200, { csrf: admin.session(token)!.csrf });
          }
          const token =
            /(?:^|;\s*)post_admin=([A-Za-z0-9_-]+)/.exec(
              req.headers.cookie ?? "",
            )?.[1] ?? "";
          const session = admin.session(token);
          auth(session);
          if (mutation) auth(req.headers["x-post-csrf"] === session.csrf);
          if (path === "/api/session" && method === "GET")
            return send(200, { csrf: session.csrf });
          if (path === "/api/logout" && method === "POST") {
            if (qq?.owner === token) await cancelQQ();
            await admin.logout(token);
            res.setHeader(
              "Set-Cookie",
              "post_admin=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0",
            );
            return send(200, { loggedOut: true });
          }
          if (path === "/api/status" && method === "GET")
            return send(200, settings.status());
          if (path === "/api/settings" && method === "GET")
            return send(200, await settings.view());
          if (path === "/api/settings" && method === "POST") {
            const input = await body(req);
            for (const a of input.accounts ?? [])
              if (a.share_url) a.share_url = shareURL(a.share_url);
            const authorization = input.qq_authorization;
            delete input.qq_authorization;
            let consumed: QQDraft | undefined;
            if (authorization) {
              auth(qq?.owner === token && qq.id === authorization.id);
              need(
                qq!.state === "authorized" &&
                  qq!.credential &&
                  qq!.expires > Date.now(),
                "unavailable",
              );
              const account = input.accounts?.find(
                (a: any) => a.id === authorization.account_id,
              );
              need(
                account?.platform === "qq" &&
                  account.id === qq!.account_id &&
                  account.native_id === qq!.credential.appId,
                "invalid_request",
              );
              need(
                !(input.secrets ?? []).some(
                  (s: any) => s.ref === account.credential,
                ),
                "invalid_request",
              );
              input.secrets = [
                ...(input.secrets ?? []),
                {
                  ref: account.credential,
                  account: account.id,
                  kind: "platform",
                  value: qq!.credential.appSecret,
                },
              ];
              consumed = qq;
            }
            const saving = settings.save(input);
            const applied = settings.pending;
            const result = await saving;
            if (
              result.saved &&
              consumed &&
              qq === consumed &&
              consumed.credential
            ) {
              const draft = consumed;
              draft.state = "applying";
              const completion = applied.then(async () => {
                if (qq !== draft || draft.state !== "applying") return;
                if (settings.status().applied) await cancelQQ("committed");
                else if (draft.expires > Date.now()) draft.state = "authorized";
                else await cancelQQ("expired");
              });
              jobs.add(completion);
              void completion.finally(() => jobs.delete(completion));
            }
            return send(200, result);
          }
          if (path === "/api/matrix/verify" && method === "POST") {
            req.socket.setTimeout(settings.config.timeout_ms + 1000);
            const input = await body(req);
            need(
              input &&
                Object.keys(input).every((k) =>
                  ["account", "credential"].includes(k),
                ),
              "invalid_request",
            );
            const proposed = ConfigSchema.shape.accounts.element.parse(
              input.account,
            );
            need(
              !settings.config.accounts.some(
                (a) =>
                  a.id !== proposed.id &&
                  a.platform === proposed.platform &&
                  a.native_id === proposed.native_id,
              ),
              "invalid_request",
            );
            const account = {
              ...proposed,
              id: settings.verifiedDraftId(
                proposed.platform,
                proposed.native_id,
                proposed.id,
              ),
            };
            need(account.platform === "matrix", "invalid_request");
            need(!settings.status().busy, "conflict");
            settings.validateAccount(account);
            need(
              input.credential === undefined ||
                (typeof input.credential === "string" &&
                  input.credential.length > 0 &&
                  input.credential.length <= 16384),
              "invalid_request",
            );
            need(
              input.credential !== undefined ||
                settings.config.accounts.some((a) => a.id === account.id),
              "invalid_request",
            );
            const credential =
              input.credential ??
              (await settings.store.secret(
                account.credential,
                account.id,
                "platform",
              ));
            const signal = AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(settings.config.timeout_ms),
            ]);
            return send(
              200,
              await verifyMatrix(
                account,
                credential,
                settings.store,
                signal,
                (verified) => {
                  const id = settings.verifiedDraftId(
                    "matrix",
                    verified,
                    account.id,
                  );
                  const normalized = { ...account, id };
                  settings.validateAccount(normalized);
                  return normalized;
                },
              ),
            );
          }
          if (path === "/api/connect/qq" && method === "GET") {
            auth(
              qq?.owner === token &&
                new URL(req.url!, origin).searchParams.get("id") === qq.id,
            );
            return send(200, publicQQ());
          }
          if (path === "/api/connect/qq" && method === "POST") {
            need(!qrMutating, "conflict");
            qrMutating = true;
            try {
              const input = await body(req);
              need(
                input &&
                  Object.keys(input).every((k) =>
                    ["action", "id", "account_id"].includes(k),
                  ),
                "invalid_request",
              );
              if (input.action === "cancel") {
                auth(qq?.owner === token && input.id === qq.id);
                await cancelQQ();
                return send(200, publicQQ());
              }
              need(input.action === "start", "invalid_request");
              need(
                typeof input.account_id === "string" &&
                  /^[a-zA-Z0-9_-]{1,64}$/.test(input.account_id),
                "invalid_request",
              );
              need(
                !qq ||
                  [
                    "cancelled",
                    "committed",
                    "expired",
                    "failed",
                    "conflict",
                  ].includes(qq.state),
                "conflict",
              );
              if (qq) await cancelQQ();
              auth(!closing && admin.session(token));
              const draft = {
                id: randomBytes(24).toString("base64url"),
                owner: token,
                expires: Date.now() + qrLifetime,
                state: "starting",
                image: null,
                native_id: null,
                imageVersion: 0,
                controller: new AbortController(),
              } as QQDraft;
              qq = draft;
              draft.flow = authorizeQQ(
                draft.controller.signal,
                (url) => {
                  if (qq !== draft || draft.controller.signal.aborted) return;
                  draft.state = url ? "waiting" : "refreshing";
                  draft.image = null;
                  const imageVersion = ++draft.imageVersion;
                  if (url) {
                    const address = new URL(url);
                    if (
                      address.protocol !== "https:" ||
                      address.hostname !== "q.qq.com" ||
                      (address.port && address.port !== "443") ||
                      address.pathname !== "/qqbot/openclaw/connect.html" ||
                      address.username ||
                      address.password ||
                      address.hash ||
                      url.length > 4096
                    ) {
                      draft.controller.abort();
                      return;
                    }
                    const image = QRCode.toDataURL(url, {
                      width: 280,
                      margin: 4,
                    })
                      .then((value) => {
                        if (
                          qq === draft &&
                          draft.imageVersion === imageVersion &&
                          draft.state === "waiting" &&
                          !draft.controller.signal.aborted
                        )
                          draft.image = value;
                      })
                      .catch(() => draft.controller.abort());
                    jobs.add(image);
                    void image.finally(() => jobs.delete(image));
                  }
                },
                connector,
              );
              draft.timer = setTimeout(() => {
                if (qq === draft) void cancelQQ("expired");
              }, qrLifetime);
              void draft.flow.done.then((credential) => {
                if (qq !== draft || draft.controller.signal.aborted) return;
                if (credential) {
                  try {
                    draft.account_id = settings.verifiedDraftId(
                      "qq",
                      credential.appId,
                      input.account_id,
                    );
                  } catch {
                    void cancelQQ("conflict");
                    return;
                  }
                }
                draft.credential = credential ?? undefined;
                draft.native_id = credential?.appId ?? null;
                draft.state = credential ? "authorized" : "failed";
                draft.image = null;
              });
              return send(200, publicQQ());
            } finally {
              qrMutating = false;
            }
          }
          if (path === "/api/token" && method === "POST") {
            const input = await body(req);
            return send(
              200,
              await settings.serialize(async () => {
                need(
                  settings.config.agents.some((a) => a.id === input.agent_id),
                  "invalid_request",
                );
                if (input.action === "issue")
                  return { token: await settings.store.issue(input.agent_id) };
                need(input.action === "revoke", "invalid_request");
                await settings.store.revoke(input.agent_id);
                return { revoked: true };
              }),
            );
          }
          if (path === "/api/discover" && method === "POST") {
            const input = await body(req);
            return send(
              200,
              await settings.serialize(async () => {
                const service = settings.app.service!;
                const authorizedDraft =
                  input.qq_authorization &&
                  qq?.owner === token &&
                  qq.id === input.qq_authorization &&
                  qq.state === "authorized" &&
                  qq.account_id === input.account_id;
                const account =
                  settings.config.accounts.find(
                    (a) => a.id === input.account_id,
                  ) ??
                  (authorizedDraft
                    ? { id: qq!.account_id!, platform: "qq" }
                    : undefined);
                need(account, "invalid_request");
                const platform = service.platforms.get(account.id);
                need(authorizedDraft || platform?.ready, "unavailable");
                const observed = settings.store.db
                  .prepare(
                    "SELECT c.seq, c.id, c.native, c.type, c.name, EXISTS(SELECT 1 FROM messages m WHERE m.account=c.account AND m.conversation=c.id) AS observed FROM conversations c WHERE c.account=? ORDER BY c.seq DESC LIMIT 200",
                  )
                  .all(account.id)
                  .map((r) => ({
                    conversation_id: r.id,
                    native_id: r.native,
                    type: r.type,
                    name:
                      r.name && String(r.name).trim()
                        ? r.name
                        : settings.store.transaction((db) =>
                            ensureConversationName(
                              db,
                              r as any,
                              account.platform,
                            ),
                          ),
                    source: r.observed ? "observed" : "configured",
                  }));
                if (!(platform instanceof MatrixUserBot))
                  return {
                    items: observed,
                    complete: false,
                    source: "local",
                    reason: "qq_directory_unsupported",
                  };
                const items = await service.track(
                  platform.discover(service.signal()),
                );
                return {
                  items: [
                    ...items.map((item) => {
                      const existing = observed.find(
                        (o) => o.native_id === item.native_id,
                      );
                      return existing
                        ? {
                            ...item,
                            conversation_id: existing.conversation_id,
                            name: existing.name,
                          }
                        : item;
                    }),
                    ...observed.filter(
                      (o) => !items.some((i) => i.native_id === o.native_id),
                    ),
                  ],
                  complete: false,
                  source: "platform",
                };
              }),
            );
          }
          if (path === "/api/qr" && method === "POST") {
            const input = await body(req);
            const link = shareURL(input.url);
            return send(200, {
              url: link,
              source: "operator_official_share",
              automatic: false,
              image: await QRCode.toDataURL(link, {
                width: 320,
                margin: 4,
                errorCorrectionLevel: "M",
              }),
            });
          }
          return send(404, { error: "not_found" });
        }
        need(method === "GET", "invalid_request");
        const file = resolve(root, path === "/" ? "index.html" : "." + path);
        need(file.startsWith(root + sep), "invalid_request");
        const bytes = await readFile(file);
        res.writeHead(200, {
          "Content-Type":
            (
              {
                ".html": "text/html; charset=utf-8",
                ".js": "text/javascript",
                ".css": "text/css",
                ".svg": "image/svg+xml",
                ".woff2": "font/woff2",
              } as Record<string, string>
            )[extname(file)] ?? "application/octet-stream",
        });
        res.end(bytes);
      } catch (e) {
        const code =
          e instanceof Unauthorized
            ? "unauthorized"
            : e instanceof Fault
              ? e.code
              : "invalid_request";
        if (!res.headersSent)
          send(
            code === "unauthorized"
              ? 401
              : code === "conflict"
                ? 409
                : code === "unavailable"
                  ? 503
                  : 400,
            {
              error: code,
              ...(code === "conflict" && settings.status().busy
                ? { busy: true }
                : {}),
            },
          );
        else res.destroy();
      } finally {
        req.socket.setTimeout(10000);
        res.removeListener("close", cancelled);
        req.removeListener("aborted", cancelled);
        // The request callback can finish before Node emits message completion for
        // a valid bodyless GET. Preserve that socket; only discard unread bodies.
        if (
          !req.complete &&
          (req.headers["transfer-encoding"] ||
            Number(req.headers["content-length"] ?? 0) > 0)
        )
          req.destroy();
      }
    })();
    jobs.add(work);
    void work.finally(() => jobs.delete(work));
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.setTimeout(10000, (socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const stop = () =>
    (stopping ??= (async () => {
      closing = true;
      const stopped = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      server.closeAllConnections();
      await cancelQQ();
      await Promise.allSettled([...jobs]);
      await stopped;
      qq = undefined;
      admin.sessions.clear();
    })());
  settings.retireManagement = stop;
  return { server, stop };
}
