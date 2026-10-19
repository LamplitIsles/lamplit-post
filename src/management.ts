import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { Admin } from "./admin";
import { Settings } from "./settings";
import { Fault, need } from "./errors";
import { isShareURL } from "./config";
import { MatrixUserBot } from "./matrix";
import QRCode from "qrcode";
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
  const jobs = new Set<Promise<void>>();
  let closing = false;
  const server = createServer((req, res) => {
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
            admin.sessions.delete(token);
            res.setHeader(
              "Set-Cookie",
              "post_admin=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0",
            );
            return send(200, { loggedOut: true });
          }
          if (path === "/api/settings" && method === "GET")
            return send(200, await settings.serialize(() => settings.view()));
          if (path === "/api/settings" && method === "POST") {
            const input = await body(req);
            for (const a of input.accounts ?? [])
              if (a.share_url) a.share_url = shareURL(a.share_url);
            return send(200, await settings.save(input));
          }
          if (path === "/api/token" && method === "POST") {
            const input = await body(req);
            return send(
              200,
              await settings.serialize(async () => {
                need(
                  settings.config.bindings.some(
                    (b) => b.agent_id === input.agent_id,
                  ),
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
                const account = settings.config.accounts.find(
                  (a) => a.id === input.account_id,
                );
                need(account, "invalid_request");
                const platform = service.platforms.get(account.id);
                need(platform?.ready, "unavailable");
                const observed = settings.store.db
                  .prepare(
                    "SELECT c.id, c.native, c.type, c.name, EXISTS(SELECT 1 FROM messages m WHERE m.account=c.account AND m.conversation=c.id) AS observed FROM conversations c WHERE c.account=? ORDER BY c.seq DESC LIMIT 200",
                  )
                  .all(account.id)
                  .map((r) => ({
                    conversation_id: r.id,
                    native_id: r.native,
                    type: r.type,
                    name: r.name ?? r.native,
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
                    ...items,
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
            { error: code },
          );
        else res.destroy();
      } finally {
        if (!req.complete) req.destroy();
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
  return {
    server,
    async stop() {
      closing = true;
      const stopped = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      server.closeAllConnections();
      await Promise.allSettled([...jobs]);
      await stopped;
      admin.sessions.clear();
    },
  };
}
