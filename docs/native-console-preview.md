# Original Koishi Console preview

This opt-in appearance preview serves the unmodified Koishi Console 5.30.11
and matching client 5.30.11, native status 7.4.10 and framework server 3.2.9.
They share Post's existing Koishi 4.18.11 application root. It is not an
administration interface: there is no human authentication, account setup,
message browser, configuration editor, marketplace, sandbox, or token/vault RPC.
Use only fresh private state with zero accounts, bindings, credentials and tokens,
behind the ko-managed VPN-only Caddy entry. Account/consumer activation remains
separate and paused. This Worker does not install or activate a live service.

## Single configuration owner

The sole source template is packaged `examples/koishi.preview.yml`. The ko
bootstrap owns initial materialization into its selected private configuration
parent and subsequent service operation; Post does not sync or generate a second
configuration. Select an immutable extracted artifact directory under HOME and
record its revision and archive hash. Perform a literal, once-only replacement
of every `__POST_ARTIFACT_ROOT__` with that absolute directory. There are exactly
four occurrences, all single-quoted YAML plugin entry keys. Reject a relative
root, colons (reserved for loader identities), apostrophes, `${{` interpolation,
or control characters (including newlines); never use shell
interpolation or replace HOME at runtime. Do not edit the packaged template.

For example, a bootstrap can read the template as UTF-8, validate its selected
root, apply `template.replaceAll('__POST_ARTIFACT_ROOT__', artifactRoot)`, and
write `koishi.yml` with mode 0600 under its mode-0700 config parent. Check the
result with Node 24:

```sh
node "$artifactRoot/dist/cli.cjs" config-check --config "$configParent/koishi.yml"
node "$artifactRoot/dist/cli.cjs" serve --config "$configParent/koishi.yml"
```

Here `artifactRoot` and `configParent` are the bootstrap's already selected
absolute paths. Canonical plugin executables resolve from that artifact's
`node_modules`, independently of the configuration directory:

- `@koishijs/plugin-server/index.cjs`
- `@koishijs/plugin-console/lib/node/index.js`
- `@koishijs/plugin-status/lib/index.js`
- `dist/post-plugin.cjs` at the artifact root

Keep the server entry before Post so Post retains its native listener lifecycle.
The server package is exports-only: an absolute package-directory entry does
not resolve. Keep these executable paths. The normal loader can append plugin
identity suffixes and rewrite formatting on serve. Help and config-check remain
read-only and do not start the loader, create keys/state, or open listeners.
The config parent must be writable by the service user for loader atomic writes.
Post resolves relative state paths through the actual loader object
(`ctx.root.get('loader').baseDir`), keeping serving and offline CLI ownership
on the same data/key paths. It never writes preview state into the artifact.

`data_dir: data` and `master_key_file: keys/post.key` resolve relative to that
private config parent, with the key outside data. First serve uses Post's usual
exclusive ownership and automatic external-key initialization, then opens the
same exact patched Minato provider. No separate database or Auth schema exists.
Empty arrays are a valid initial state even without Console; entries still use
all existing account/identity/admission validation. Preview starts healthy with
zero native IM clients, no webhook recipient, no issued machine token, and no
deliveries. MCP and assets continue rejecting requests without agent auth.

## Network and read-only boundary

The canonical preview explicitly binds native UI HTTP to `127.0.0.1:5140`, and
Post API to `127.0.0.1:18787`. The ordinary Post default remains 8787; preview
uses a different fixed port because the host already assigns 8787 elsewhere.
There is no port auto-detection or fallback. A private fixture may inject its
own free ports. The Console server may select another explicit positive port
in the same YAML; wildcard/nonloopback hosts and a shared API port are refused.

Caddy proxies the whole root to 5140, including `/client.js`, native static
resources and `/@plugin-*/...`. The native welcome page lives at `/`; status supplies real footer widgets
and tooltips, not a dedicated page. HTTP `/status` falls back to the welcome
SPA; WebSocket upgrade `/status` is the native data channel. `uiPath: ''`, `apiPath: /status`
and `selfUrl: ''` retain same-origin asset/WS URLs through HTTPS. Post `/mcp`,
`/assets` and `/healthz` remain on 18787; the Console proxy is not a bearer-auth
bypass to them. No public ingress or new DNS/certificate work belongs here.

The published shell's full RPC registry contains **only `ping`**, returning
`pong`; native status adds no handlers. Native push services publish entry URLs,
schema/permission metadata, environment versions and CPU/memory/bot status.
The empty preview has no bot/message/credential payload. Status requires no
database and performs no configuration or account mutation. Tests assert the
complete runtime listener registry, exercise real WS status/ping, and send
privileged RPC names to confirm `not implemented`; the safety claim does not
rely on hidden buttons. The public native shell also exposes ordinary local
browser preferences; these do not mutate backend configuration.

Config-check/serve permit only these three artifact-resolved native plugins
alongside Post when Console is selected. Extra plugins/options, devMode,
nonempty accounts/bindings and external asset/WS endpoints are refused. Legacy
root listener fields (`host`, `port`, `maxPort`, `selfUrl`) are refused before
the loader can migrate them into another server. Console inside a framework
`group:*` is detected and rejected by the same flat preview allowlist. Adding
another native module requires a fresh handler/data audit before exposure.
This restriction is a narrow unauthenticated preview boundary, not an Auth
system for populated Post installations.

Shutdown stops the framework UI listener and WS layers, terminates remaining
UI sockets and awaits native server closure before Post closes MCP/platform
work, its provider, and finally the data owner. Fatal startup applies that cleanup
even when ownership is refused, then uses
the loader's explicit failure exit so sibling status timers cannot keep a
failed preview running. An existing refused owner is never released by Post.
Signal the complete supervisor process group. Restart reopens consistent empty
state without any native send.
The artifact contains all published Console/status dist resources and package
links; no checkout, frontend build, dependency install or external CDN is needed
at startup. `artifact-manifest.json` inventories exact file hashes/internal links;
`revision.json` records build revision and provider patch identity.

## Isolated acceptance and activation

Run the repository's required typecheck, test, build and package commands.
`tests/console.test.ts` verifies the native root/RPC registry and an extracted
artifact using the canonical materialization rule, private HOME/config/state,
owned ports, real MCP SDK and WS, asset requests, denial, shutdown and restart.
Browser evidence must use agent-browser against that isolated extracted runtime;
retain exact HEAD, screenshot, native navigation/status-widget interaction and WS status evidence in
ignored `.scratch/native-console-preview/`. No custom UI or Penpot design is
part of this scope. Preserve earlier evidence and disclose any timing failures.

After independent review and merged Post/ko PRs, Orc selects and verifies the
immutable artifact and follows ko's target-specific activation/runbook. Building
or merging alone does not deploy. Verify the VPN entry's HTTP assets and WS,
zero connected accounts and denied privileged RPC, and record deployed revision
separately. Never add real credentials/accounts/tokens to this unauthenticated
preview. A populated dashboard requires a separately reviewed Auth design.
