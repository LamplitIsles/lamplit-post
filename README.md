# Lamplit Post

Post Office for Agents: one private backend for official QQ Bot and existing Matrix user accounts. Post stores observed messages and attachments permanently, applies each agent's admission and wake policy, exposes seven MCP tools, and durably delivers eligible wakes to a fixed receiver. Consumers own their execution sessions; QQ and Matrix can feed the same existing CFL session.

V1 is backend-only. It uses stable Koishi/Satori, the published QQ 4.14.0 adapter, a local Matrix access-token adapter, Bun SQLite, private asset files, and a sealed credential vault. No Matrix Application Service registration or browser console is required.

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
bun dist/cli.js --help
```

Start with [the operator guide](docs/operator.md) and [example TOML](examples/post.toml). First state initialization automatically creates the configured external master key if state is genuinely fresh; subsequent starts reuse it. Existing state with a lost key fails closed. Secrets enter through offline stdin provisioning; agent API tokens are independently issued/revoked. Help and configuration validation create no state.

The [canonical consumer contract](contracts/v1/README.md), [executable schemas](contracts/v1/index.ts), and [concrete JSON examples](contracts/v1/examples.json) are the integration authority for CFL spec #4067. Contract revision is `ef2fa54ec90630bad5b38b2768a13b7bf543dc4c`. Raw authenticated upload/download routes let remote consumers use stable asset IDs without server-local paths. PostEventV1 retries preserve ID and serialized body; a receiver acknowledges only after durable acceptance.

Tests own their temporary HOME, SQLite, key files, HTTP/WS endpoints and credentials. QQ traffic uses the actual published adapter against an isolated gateway; Matrix uses the actual SDK against owned homeserver endpoints. The fake QQ gateway uses Node and the published `ws` server to avoid Bun's native test-server shim; Post production runs only Bun. Tests make no real IM requests or external messages.

`bun run package` prepares the bundled CLI, example configuration, service template, license and operator guide under `dist/artifact`. Deployment and actual CFL cutover are a later Orc-owned action after independent review and merge. Building or merging does not install or start a service.

Platform grants still determine what QQ can observe. QQ ordinary-group member listing is explicitly unsupported by this adapter's public API; it does not substitute channel rosters or remembered senders. Matrix access requires current joined plaintext rooms and a real roster; encrypted rooms are excluded. Audio/video remain retrievable attachments and outbound ordinary files. V1 has no frontend, Console, FTS, MCP Events, native audio/video codecs, or historical import.
