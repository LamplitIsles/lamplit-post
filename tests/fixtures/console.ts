import WebSocket from "ws";
import { once } from "node:events";
export async function rpc(url: string) {
  const socket = new WebSocket(url);
  const data = new Map<string, any>();
  const pending = new Map<string, (body: any) => void>();
  socket.on("message", (bytes) => {
    const packet = JSON.parse(bytes.toString());
    if (packet.type === "response") pending.get(packet.body.id)?.(packet.body);
    if (packet.type === "data") data.set(packet.body.key, packet.body.value);
  });
  socket.on("close", () => {
    for (const [id, resolve] of pending) resolve({ id, closed: true });
  });
  await once(socket, "open");
  let id = 0;
  return {
    socket,
    data,
    async call(type: string, ...args: any[]) {
      const key = String(++id);
      console.log("RPC", type);
      return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error(`RPC timeout: ${type}`)),
          15000,
        );
        pending.set(key, (body) => {
          clearTimeout(timer);
          pending.delete(key);
          resolve(body);
        });
        socket.send(JSON.stringify({ id: key, type, args }));
      });
    },
  };
}
