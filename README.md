# Lamplit Post

**One private IM backend connects QQ and Matrix conversations to an agent's existing execution session.** Post archives actual observations and media, applies admission and wake rules, exposes seven MCP tools, and durably delivers eligible wakes.

```sh
pnpm install --frozen-lockfile
pnpm run build
node dist/cli.cjs --help
node dist/cli.cjs config-check --config examples/koishi.yml
```

Post runs on Node 24 with one Koishi application root, one Post plugin/service, and one Minato SQLite provider. The published QQ adapter and custom Matrix user-access-token adapter share that root. Configuration lives in one Koishi YAML Post entry; the framework Schema describes its fields and Post validates cross-references and private paths. Credentials stay in the sealed vault with a separate external key. Machine agent tokens identify consumers independently of platform and receiver credentials.

Use the [native managed app guide](docs/native-managed-console.md) and [seed YAML](examples/koishi.managed.yml) for the original Console with Auth, Config, Market, Insight, Analytics, safe Logger and Vanilla. One persistent writable app owns its manifest, lock, modules and YAML; trusted administrators can install compatible plugins through the native Installer. First administrator provisioning delivers its password only to an explicit private file.

Start with [the operator guide](docs/operator.md) and [example configuration](examples/koishi.yml). Operator-verified native identities and private paths are required before connecting an account. Help, invalid arguments and read-only config checks do not initialize state or rewrite configuration. Configuration changes take effect through a coherent restart.

The [consumer contract](contracts/v1/README.md), [executable schemas](contracts/v1/index.ts), and [JSON examples](contracts/v1/examples.json) retain revision `ef2fa54ec90630bad5b38b2768a13b7bf543dc4c`. QQ and Matrix can feed the same CFL session. Receivers acknowledge only durable acceptance; retries preserve immutable event bytes. Unknown native sends remain unresolved and are never automatically resent.

```sh
pnpm run typecheck
pnpm test
pnpm run build
pnpm run package
```

Packaging produces `dist/node-artifact` and `dist/lamplit-post-node24.tar.gz`, including framework dependencies, dynamic resources, revision metadata, operator docs and an inert service template. Node24 and a compatible pnpm12 are supplied separately. Extract the seed once to a new private app root (default `~/.local/share/lamplit-post/app`) and use `pnpm run config-check`, offline `pnpm run admin-provision --file /absolute/private/delivery-file`, then `pnpm run start` there. Service startup never installs dependencies. Tests use Node, Vitest, real MCP HTTP, the published QQ WS/REST adapter, the real Matrix SDK, and owned local fixtures. They include crash/reopen, extracted-artifact, private-peer, catchup, ordered-content, image-preflight and shared-deadline checks.

The exact native provider compatibility decision and bounded transaction repair are documented in [framework persistence](docs/framework-persistence.md). The native management pages reuse the original frontend and human Auth model on that provider. There is no custom Post dashboard, FTS, MCP Events, Matrix AS/E2EE, native codec, legacy state migration, or separate database server. Audio/video remain attachments. Deployment remains paused and belongs to Orc after reviewed merge; building or merging does not install a service.

Post is licensed under [AGPL-3.0](LICENSE). Its framework dependencies retain their own licenses; provider attribution is included with the patch documentation.
