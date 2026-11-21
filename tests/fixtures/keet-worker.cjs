const RPC = require("tiny-buffer-rpc");
const codec = require("tiny-buffer-rpc/any.js");
const fs = require("node:fs");
const ipc = new (require("node:net").Socket)({
  fd: 3,
  readable: true,
  writable: true,
});
const rpc = new RPC((message) => {
  const frame = Buffer.alloc(message.length + 4);
  frame.writeUInt32LE(message.length);
  message.copy(frame, 4);
  ipc.write(frame);
});
const response = (id) => async (args) => {
  if (id === 1)
    return {
      modules: { "keet-core": "4.26.4" },
      buildType: "Production",
      abi: { min: 40, max: 40, autoupgrade: 37 },
      ...JSON.parse(
        fs.existsSync(process.argv[2] + "/version.json")
          ? fs.readFileSync(process.argv[2] + "/version.json", "utf8")
          : "{}",
      ),
    };
  if (id === 6) return { memberId: "test-member" };
  if (id === 39) {
    fs.appendFileSync(process.argv[2] + "/requests", "request\n");
    if (args[0] === "hang") return new Promise(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { ok: true };
  }
  return null;
};
for (const id of [
  0, 1, 6, 19, 22, 28, 39, 43, 66, 105, 141, 142, 145, 158, 160, 163, 165, 185,
  199, 243,
])
  rpc.register(id, {
    request: codec,
    response: codec,
    onrequest: response(id),
  });
let input = Buffer.alloc(0);
ipc.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4 && input.length >= input.readUInt32LE() + 4) {
    const length = input.readUInt32LE();
    rpc.recv(input.subarray(4, 4 + length));
    input = input.subarray(4 + length);
  }
});
ipc.on("end", () => {
  rpc.destroy();
  ipc.destroy();
});
if (!fs.existsSync(process.argv[2] + "/delay-start"))
  console.log("Keet core worker started");
