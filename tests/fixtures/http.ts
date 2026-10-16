import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
/** Only test-owned loopback endpoints; abort means actual client socket termination. */
export async function httpFixture(
  fetch: (request: Request) => Promise<Response> | Response,
) {
  const active = new Set<AbortController>();
  const server = createServer((incoming, outgoing) => {
    const controller = new AbortController();
    active.add(controller);
    outgoing.once("close", () => {
      controller.abort();
      active.delete(controller);
    });
    void (async () => {
      const method = incoming.method ?? "GET";
      const req = new Request("http://127.0.0.1" + incoming.url, {
        method,
        headers: incoming.headers as HeadersInit,
        body: ["GET", "HEAD"].includes(method)
          ? undefined
          : (Readable.toWeb(incoming) as any),
        signal: controller.signal,
        ...{ duplex: "half" },
      });
      const response = await fetch(req);
      if (outgoing.destroyed) return;
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body)
        await pipeline(Readable.fromWeb(response.body as any), outgoing);
      else outgoing.end();
    })().catch(() => outgoing.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: (server.address() as any).port as number,
    async stop() {
      for (const c of active) c.abort();
      const closed = new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections();
      await closed;
    },
  };
}
