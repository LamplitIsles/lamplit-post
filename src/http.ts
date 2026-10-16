import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { boundedBytes } from "./io";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ToolInputs, ToolOutputs } from "../contracts/v1/index";
import { Service } from "./service";
import { Fault } from "./errors";
export async function serve(service: Service) {
  // Own the actual request socket so a shared body deadline closes dripping I/O.
  const server = createServer((incoming, outgoing) => {
    const disconnected = new AbortController();
    const abort = () => disconnected.abort();
    outgoing.once("close", abort);
    let detachBody = () => {};
    const body = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          const data = (chunk: Buffer) => {
            controller.enqueue(chunk);
            if ((controller.desiredSize ?? 0) <= 0) incoming.pause();
          };
          const end = () => {
            detachBody();
            controller.close();
          };
          const error = (reason: Error) => {
            detachBody();
            controller.error(reason);
          };
          detachBody = () => {
            incoming.off("data", data);
            incoming.off("end", end);
            incoming.off("error", error);
          };
          incoming.on("data", data);
          incoming.once("end", end);
          incoming.once("error", error);
        },
        pull() {
          incoming.resume();
        },
        // Stop reading now; destroy after the error response is flushed, avoiding an implicit 200.
        cancel() {
          incoming.pause();
          detachBody();
        },
      });
    const work = async () => {
      try {
        const method = incoming.method ?? "GET";
        const req = new Request(
          `http://${service.config.hostname}${incoming.url ?? "/"}`,
          {
            method,
            headers: incoming.headers as HeadersInit,
            body: method === "GET" || method === "HEAD" ? undefined : body(),
            signal: disconnected.signal,
            ...{ duplex: "half" },
          },
        );
        const response = await handle(req);
        if (outgoing.destroyed) return;
        outgoing.writeHead(
          response.status,
          Object.fromEntries(response.headers),
        );
        if (response.body)
          await pipeline(Readable.fromWeb(response.body as any), outgoing);
        else outgoing.end();
      } catch {
        outgoing.destroy();
      } finally {
        detachBody();
        if (!incoming.complete) incoming.destroy();
        outgoing.removeListener("close", abort);
      }
    };
    void service.track(work());
  });
  server.setTimeout(service.config.timeout_ms + 2000, (socket) =>
    socket.destroy(),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(service.config.port, service.config.hostname, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  async function handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/healthz") {
      try {
        const healthy = (await service.status()).healthy;
        return Response.json({ healthy }, { status: healthy ? 200 : 503 });
      } catch {
        return Response.json({ healthy: false }, { status: 503 });
      }
    }
    const auth = req.headers.get("authorization"),
      agent = auth?.startsWith("Bearer ")
        ? service.store.authenticate(auth.slice(7))
        : undefined;
    if (!agent || service.closed)
      return new Response(null, {
        status: 401,
        headers: { Connection: "close" },
      });
    try {
      if (path === "/mcp") {
        if (req.headers.has("origin"))
          return new Response(null, { status: 403 });
        // Start one deadline before reading any body; the SDK only sees bounded, complete bytes.
        const signal = service.signal(req.signal);
        let boundedRequest = req;
        if (req.method === "POST") {
          try {
            const bytes = await boundedBytes(
              new Response(req.body),
              signal,
              131072,
            );
            signal.throwIfAborted();
            boundedRequest = new Request(req, { body: bytes, signal });
          } catch (e) {
            return new Response(null, {
              status: e instanceof Fault && e.code === "capacity" ? 413 : 408,
              headers: { Connection: "close" },
            });
          }
        }
        const mcp = new Server(
          { name: "lamplit-post", version: "1.0.0" },
          { capabilities: { tools: {} } },
        );
        const transport = new WebStandardStreamableHTTPServerTransport({
          enableJsonResponse: true,
          maxRequestBodySize: 131072,
        });
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: Object.entries(ToolInputs).map(([name, schema]) => ({
            name,
            description: `Post v1 ${name}`,
            inputSchema: z.toJSONSchema(schema) as any,
          })),
        }));
        mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
          try {
            const name = request.params.name as keyof typeof ToolInputs;
            if (!Object.hasOwn(ToolInputs, name))
              throw new Fault("invalid_request");
            const value = ToolOutputs[name].parse(
              await service.call(
                agent,
                name,
                request.params.arguments ?? {},
                AbortSignal.any([signal, extra.signal]),
              ),
            );
            return {
              structuredContent: value,
              content: [{ type: "text" as const, text: JSON.stringify(value) }],
            };
          } catch (e) {
            const error = {
              error: {
                code:
                  e instanceof Fault
                    ? e.code
                    : e instanceof z.ZodError
                      ? "invalid_request"
                      : "unavailable",
                message:
                  e instanceof Fault ? e.message : "Operation unavailable",
              },
            };
            return {
              isError: true,
              structuredContent: error,
              content: [{ type: "text" as const, text: JSON.stringify(error) }],
            };
          }
        });
        await mcp.connect(transport);
        try {
          signal.throwIfAborted();
          return await transport.handleRequest(boundedRequest);
        } finally {
          await mcp.close();
        }
      }
      if (path === "/assets" && req.method === "POST") {
        try {
          const meta = await service.assets.ingest(
            req.body,
            req.headers.get("content-type")?.split(";")[0] ?? "",
            req.headers.get("x-post-filename") ?? "attachment",
            agent,
            service.signal(req.signal),
          );
          return Response.json(meta, { status: 201 });
        } catch (e) {
          return new Response(null, {
            headers: { Connection: "close" },
            status:
              e instanceof Fault ? (e.code === "capacity" ? 413 : 415) : 408,
          });
        }
      }
      if (/^\/assets\/ast_[\w-]+$/.test(path) && req.method === "GET") {
        const id = path.slice("/assets/".length);
        const meta = await service.call(
          agent,
          "get_asset",
          { asset_id: id },
          req.signal,
        );
        if (meta.status !== "available") throw new Fault("not_found");
        const row = (await service.assets.row(id))!;
        return new Response(await service.assets.bytes(id, req.signal), {
          headers: {
            "Content-Type": meta.mime,
            "Content-Length": String(meta.size),
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      return new Response(null, { status: 404 });
    } catch (e) {
      return new Response(null, {
        status: e instanceof Fault && e.code === "not_found" ? 404 : 503,
      });
    }
  }
  return {
    url: `http://${service.config.hostname}:${(server.address() as { port: number }).port}`,
    async stop() {
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      server.closeAllConnections();
      await closed;
    },
  };
}
