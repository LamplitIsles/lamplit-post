# Lamplit Post

**Connect QQ and Matrix conversations to an agent's existing execution session through one private backend.** Post records actual observations, applies admission and wake rules, exposes seven MCP tools, and retries durable wake deliveries.

```sh
npm ci
npm run build
node dist/cli.cjs --help
node dist/cli.cjs config-check --config examples/post.toml
```

Post runs directly on Node 24. Satori/Cordis hosts the published QQ adapter;
Matrix uses the account access-token SDK. Post owns one SQLite connection,
a sealed credential vault, and one strict TOML configuration. Opt-in
[authenticated settings](docs/settings.md) add an agent-first browser UI; the
backend runs headlessly by default.

Start with the [operator guide](docs/operator.md) and
[example configuration](examples/post.toml). Native identities must be verified
by the operator before connecting accounts. Secrets enter the vault through
stdin, independently of agent Bearer tokens and receiver credentials.
Help and config checks create no state. Offline file changes apply on restart;
protected settings saves wait for controlled apply.

The [consumer contract](contracts/v1/README.md),
[executable schemas](contracts/v1/index.ts) and
[examples](contracts/v1/examples.json) retain revision
`ef2fa54ec90630bad5b38b2768a13b7bf543dc4c`.
Receivers acknowledge durable acceptance; retry bodies remain immutable.
Unknown sends are never automatically resent. QQ and Matrix can feed the same
consumer session.

```sh
npm run typecheck
npm test
npm run build
npm run package
```

Packaging produces `dist/node-artifact` and `dist/lamplit-post-node24.tar.gz`,
with dependencies, dynamic SDK resources, revision and file/link inventories,
operator docs and an inert service template. Extracted runtime needs Node 24,
with no package manager involved in startup. Tests use real QQ/Matrix/MCP SDKs
and test-owned local HTTP/WS/receiver fixtures.

[Persistence](docs/persistence.md) describes the restored lightweight standalone
format and [dependencies](docs/dependencies.md) documents the exact Matrix timer
repair. Fresh installation is the supported transition path. The deployed
framework database is unsupported and refused; no conversion or reset is provided.
The existing installed managed service stays untouched until a separately planned
operator transition. Building or merging does not deploy.

Matrix AS/E2EE, FTS and MCP Events are outside this
backend. Audio/video remain ordinary attachments.

Post is licensed under [AGPL-3.0](LICENSE); dependencies retain their own licenses.

Optional [authenticated agent settings](docs/settings.md) provide the real Svelte 5
UI on loopback port 5140. Provision the independent administrator offline first.
Headless operation remains the default; enabling settings does not deploy or
replace any existing installation.
