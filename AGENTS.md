# Post implementation guidance

Read `CONTEXT.md` for domain terminology and `contracts/v1/README.md` for the consumer boundary. Product authority is FlickNote #4066; CFL integration belongs to its separate repository/spec #4067. Coordinate any public contract change with the owning Orc before implementation.

Use Bun and the committed lockfile. Keep stable Koishi/Satori public seams; do not fork App/core or build native codecs. No UI, FTS, or MCP Events in V1. Never persist platform secrets in TOML, messages, logs, or API errors. Credentials, agent-token digests, and receiver authentication have separate purposes.

Run `bun run typecheck`, `bun test`, `bun run build`, and `bun run package` for backend changes. Tests must own all HOME/data/key/config directories and platform/receiver endpoints. Do not contact real QQ/Matrix accounts, mutate installed services, or perform a live cutover during implementation acceptance. Node is used only for the isolated fake QQ gateway; production runtime is Bun.

Observation and eligible delivery commit together. Queue snapshots are immutable; native sends are never automatically replayed. Treat unknown as unresolved, preserve native confirmations even if local storage fails, and cancel actual I/O on shutdown. Every query, media request and send checks admission; opaque IDs are never authorization.

Keep operator artifacts in `docs/`, `deploy/`, and `examples/`. Keep local implementation evidence under ignored `.scratch/post-v1-backend/`; never stage `.scratch`. Deployment requires the documented target-specific steps after reviewed merge, owned by Orc.
