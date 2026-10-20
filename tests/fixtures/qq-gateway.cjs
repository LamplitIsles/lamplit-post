// Test-owned Node transport process using the published ws server.
const { WebSocketServer } = require("ws");
let rejectConnections = false;
const server = new WebSocketServer({
  host: "127.0.0.1",
  port: 0,
  verifyClient(_info, done) {
    process.send({ attempt: true });
    done(!rejectConnections, 503);
  },
});
let socket,
  seq = 0;
server.on("listening", () => process.send({ port: server.address().port }));
server.on("connection", (ws) => {
  socket = ws;
  process.send({ connected: true });
  ws.on("close", (code) => process.send({ closed: code }));
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
  if (m.rejectConnections !== undefined) {
    rejectConnections = m.rejectConnections;
    process.send({ configured: true });
  } else if (m.disconnect) {
    socket?.close(1000);
  } else if (m.close) {
    for (const ws of server.clients) ws.terminate();
    server.close(() => process.exit(0));
  } else if (socket) socket.send(JSON.stringify({ ...m, s: ++seq }));
});
process.on("disconnect", () => process.exit(0));
