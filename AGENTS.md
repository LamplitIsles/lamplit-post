# Post implementation guidance

Read `CONTEXT.md` for domain terminology and `contracts/v1/README.md` for the fixed consumer boundary. Framework-native authority is FlickNote #4079; #4066 is completed product context and CFL remains in its own repository. Coordinate public contract changes with the owning Orc.

Use Node 24, pnpm and the committed lockfile. For backend changes run `pnpm run typecheck`, `pnpm test`, `pnpm run build`, and `pnpm run package`. Package tests need the complete artifact; `pnpm test` prepares it. Keep Koishi/Satori public seams and one application root. Read `docs/framework-persistence.md` before changing the exact provider, compatibility metadata, transaction patch, schema or startup ownership.

Configuration has one Koishi YAML Post entry and one framework Schema. Post owns identity/admission/wake, the sealed vault, machine agent digests, immutable delivery snapshots and send reconciliation on one Minato provider. Acquire the private external key and exclusive data ownership before opening the provider. Unknown state must be refused before schema preparation. Release ownership only after actual I/O and provider work finish. Keep credentials out of configuration, messages, logs and API errors.

Observation and eligible delivery commit together. Network I/O stays outside transactions. Queue snapshots are immutable; unknown native outcomes stay unresolved without automatic resend. Preserve confirmed receipts when archiving fails. Every history/member/media/send operation rechecks admission; opaque IDs grant no authority.

Tests own HOME/data/key/config directories, subprocess groups and platform/receiver endpoints. Use the real SDKs against local fixtures; preserve private-peer admission, Matrix catchup suppression, ordered mentions, image preflight, shared HTTP deadlines and native-handoff receipts. No real accounts, live service mutation, deployment, or cutover during implementation acceptance. No UI, Console, human Auth, FTS, or MCP Events in this backend scope.

Operator artifacts belong in `docs/`, `deploy/`, and `examples/`. Local evidence belongs under ignored `.scratch/framework-native-backend/`; preserve prior ignored evidence and never stage `.scratch`. Deployment remains paused and requires Orc's target-specific documented steps after reviewed merge.
