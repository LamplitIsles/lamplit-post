// Test-owned transport process: use published ws server under Node, avoiding Bun's server shim.
const { WebSocketServer } = require("ws");
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
let socket,
  seq = 0;
server.on("listening", () => process.send({ port: server.address().port }));
server.on("connection", (ws) => {
  socket = ws;
  ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }));
  ws.on("message", (raw) => {
    const p = JSON.parse(String(raw));
    if (p.op === 2 || p.op === 6)
      ws.send(
        JSON.stringify({
          op: 0,
          t: p.op === 2 ? "READY" : "RESUMED",
          s: ++seq,
          d: {
            session_id: "fixture",
            user: { id: "qq-user", username: "Test Bot" },
          },
        }),
      );
    if (p.op === 1) ws.send(JSON.stringify({ op: 11 }));
  });
});
process.on("message", (m) => {
  if (m.close) {
    for (const ws of server.clients) ws.terminate();
    server.close(() => process.exit(0));
  } else if (socket) socket.send(JSON.stringify({ ...m, s: ++seq }));
});
process.on("disconnect", () => process.exit(0));
