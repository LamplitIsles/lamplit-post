# Native managed Koishi application

Post runs one persistent writable Koishi app. Native Auth, Config, Market,
Insight, Analytics, Logger and Vanilla share its root, framework and provider.
The original Console UI and protocol are retained, with the narrow browser debug
payload suppression described below. Administrator-installed
compatible plugins use ordinary Koishi resolution and lifecycle; there is no
plugin allowlist or separate plugin store.

## Seed and start

Build with Node24 and the repository's pnpm lockfile. `pnpm run package` produces
`dist/lamplit-post-node24.tar.gz` and its uncompressed `dist/node-artifact`.
The archive includes all runtime dependencies and native frontend resources.
Record `revision.json`, `artifact-manifest.json` and the archive SHA256. An
artifact marked `working_tree_dirty:true` is implementation evidence, not a
reviewed release.

The default target is `$HOME/.local/share/lamplit-post/app`. An operator extracts
the seed **once into a new empty private directory**. That becomes the live
application, not a synchronized copy of a release. It contains:

| Path | Owner |
| --- | --- |
| `package.json`, `pnpm-lock.yaml`, `node_modules` | native Market/Installer and pnpm |
| `pnpm-workspace.yaml`, `patches/` | normal package-manager compatibility inputs |
| `koishi.yml` | native Loader/Config; one Post Schema entry |
| `post/package.json`, `post/dist/post-plugin.cjs` | versioned local `koishi-plugin-post` file dependency |
| `dist/cli.cjs` | versioned offline CLI and native supervisor launcher |
| `data/`, `keys/post.key` | default exclusive Post state and separate external key |
| `logs/` | native Logger, outside exclusive SQLite data |

Use real Node24 and pnpm>=12.3.4<13 on PATH; both pnpm12.3.4 and the development12.11.2
are exercised by owned acceptance. From the application directory:

```sh
pnpm run config-check
pnpm run start
```

The app has no exact `packageManager` redirect. `pnpm run start` supplies the
actual inherited `npm_config_user_agent`; native `which-pm-runs` uses this
variable, not the manifest or lockfile. The CLI refuses an absent/non-pnpm12
user agent. A service must expose the selected pnpm executable on PATH as well
as Node. Do not use a shim which downloads the package manager at startup.
`verifyDepsBeforeRun:false` prevents pnpm's automatic pre-run installation.
`frozenLockfile:false` lets an explicit Market action update the sole lock.
Normal pnpm12 owns any module-tree replacement during that action. Starts never install,
initialize from a release, overwrite YAML, or download dependencies.

The public `baseDir` field and service are bootstrapped from the actual Loader
once; cwd and Loader root are the same app directory. Config, Market and Logger
resolve their resources there. Default UI is `127.0.0.1:5140`, static root `/`,
WebSocket `/status`; private Post health/MCP/assets are `127.0.0.1:18787`.
There is no port fallback. Keep the existing VPN same-origin reverse proxy
pointing at5140, including `/client.js`, `/@plugin-*` and WebSocket traffic.
An administrator can install code: this is a trusted private administration
surface, not a plugin sandbox or an internet-facing identity service.

`data_dir` and `master_key_file` resolve from the sole YAML directory. For the
existing deployment, Orc can put the existing absolute
`$HOME/.local/state/lamplit-post/console/data` and
`$HOME/.local/state/lamplit-post/console/keys/post.key` in this YAML. Never copy,
reset or regenerate existing database/key state as part of app seeding. Logs
must remain outside that data directory so they cannot pollute fresh-state
identification.

## First human administrator

Stop Post first. Create a mode0700 delivery directory explicitly; from app root:

```sh
install -d -m 0700 "$HOME/.local/state/lamplit-post/first-owner"
pnpm run admin-provision --file "$HOME/.local/state/lamplit-post/first-owner/login.txt"
```

The command creates a new mode0600 file with a high-entropy initial password and
native user0 (`admin`, authority5) on the same Minato provider. It prints only
result/path. It refuses an existing delivery file and unsafe parent permissions.
An already provisioned user0 is left unchanged; repeated init/start never resets
its password or revokes tokens. Keep native `auth.admin.enabled:false` in YAML.
Plaintext passwords never belong in YAML, unit environment, argv or logs.
Platform and receiver credentials remain sealed vault references; the existing
offline credential CLI remains the enrollment path.

**Only the human operator reads the real delivery file.** After Orc deploys,
Neil runs this locally (agents must not run it on real state):

```sh
cat "$HOME/.local/state/lamplit-post/first-owner/login.txt"
```

Open `https://lamplit-post.nuc.guion.io`, log in as `admin`, change the password
in native account settings, then remove the initial delivery file after confirming
the new login. Its purpose is delivery, not a permanent password backup.
Administrator passwords, the external master key and machine agent tokens are
independent. Changing the login password does not re-encrypt the vault. A human
Console token never grants Post MCP/assets admission.

Auth4.1.7 uses unsalted SHA256 passwords and Math.random-generated native login
tokens/platform codes. These upstream limitations remain; the high-entropy
initial secret does not replace that model. Runtime user updates accept only
native name/password/preferences fields, not authority/id edits. Native authority
and expiry checks guard management data/RPCs. Post adds a fail-closed intercept
while Auth is absent, starting or failed. Static plugin entries and login RPCs
remain available so login can complete. Keep this service private behind VPN.

## Management and config application

Config discovers the normal local Post package and its actual Schema, including
accounts, bindings, scopes and wake settings. Invalid domain references are
rejected before native Config writes, including edits submitted through a group.
Existing identity and conversation pins are checked read-only on the owned
provider before saving or restarting; edits cannot rebind persisted IDs. Native
Config's metadata RPC accepts its menu's `$label`/`$collapsed` fields only;
filters, conditions and plugin/domain options use normal reload. Post
field/endpoint/key-path checks remain in effect; native secret input masking is not a vault. Platform credentials are
never copied into Config responses.

Ordinary plugin updates and enable/disable retain native behavior. A Post domain or root UI-listener
edit validates first, lets native Config write the one YAML and acknowledge,
then drains actual UI/MCP/platform work, active native Installer work, Analytics
and Logger, closes the provider and releases exclusive ownership before native
worker code51 restart. A reconnect shows the applied settings. Normal failures
with `daemon.autoRestart:false` are left to the service manager; code51 still
restarts the CLI worker. Stop the complete supervisor process group.

Native Market writes the manifest before running pnpm. A failed install can
therefore leave its requested dependency in `package.json`; it does not promise
an atomic manifest/lock rollback. Reported nonzero failure is real. Repair the
request and retry, or restore a chosen stopped-app snapshot. Successful native
changes can restart the worker and reconnect the page. Loaded dependencies are
identified before pnpm changes links so a cached old manifest cannot leave old
plugin code active after a successful update. The owned acceptance
installs, updates, enables/disables and uninstalls a fixture package using the
real Installer/pnpm; it does not certify arbitrary third-party plugins.

## Native statistics, logs and themes

Analytics counts native framework events: receive and confirmed send on QQ and
Matrix, plus native user/channel/command metrics. Matrix inbound dispatch and QQ
confirmed-send events already exist; only Matrix confirmed-send dispatch was
added. Failed/unknown sends do not invent confirmations. Catchup can contribute
native receive events while Post correctly suppresses new wakes. These graphs
are not canonical archive/delivery/ACK counts or agent-turn counts. Empty bot and
command charts are honest before those events exist; the provisioned human user
may already contribute to native user totals. No archive backfill is implied.

Insight shows the actual framework dependency graph. Vanilla themes and browser/
user preferences use the stock frontend. No authored Post dashboard is included.

Logger retains its original UI, rotation and retention. Every incoming record is
reconstructed from bounded category/severity values and explicit Post event enums
before it reaches the native writer or WebSocket patch. Raw SDK errors, bodies,
credential strings, arbitrary metadata and arguments are discarded, including
startup prolog. Safe lifecycle/package outcomes remain. Namespace alone is not
considered redaction. This deliberately trades raw diagnostic detail for a safe
operational record. The separate key/vault and private message archive are never
log inputs.

## Narrow dependency repairs

The exact SQLite provider decision/unchanged patch is documented in
[framework persistence](framework-persistence.md). Integration repairs use
ordinary pnpm `patchedDependencies`, shipped with the app inputs:

- Market2.11.12: bind `registry.get` to its HTTP instance before passing it to
  native Scanner. With HTTP0.6.3 the unbound call uses Scanner as `this` and throws
  `TypeError: this is not a function`. Source and shipped CJS receive the same
  one-line fix. Real Scanner/local-registry acceptance supplies causal evidence.
- Client5.30.11 source and Console5.30.11 shipped `dist/client.js`: suppress
  send/receive debug payload arguments before browser DevTools can record login
  passwords, tokens or Config data. Debug message types remain. These are the
  two published halves of the same client; the UI and protocol are unchanged.
- Logger2.6.9: native disposal discarded the async writer-close result and the
  CLI exit path did not dispose that scope. A typed idempotent `logger/close`
  event and tracked retention/rotation work provide an awaited native I/O barrier.
  Its UI and logging/storage implementation remain upstream.

These patches retain original package metadata/licenses and source; no core or
frontend fork is used. Patch hashes and packaged file/resource hashes are recorded
in the artifact inventory and implementation report. Native subsequent installs
retain these patches and provider compatibility inputs; administrator-selected
compatible packages are not frozen by a whitelist.

## Install, update and rollback

Orc owns target-specific installation after independent reviews and merged Post/ko
PRs. The old empty preview can be stopped and its launcher/YAML privately saved;
the new sole YAML can reference its existing database/key paths. There is no
migration framework or parallel runtime. Account enrollment and consumer cutover
remain separately paused.

Before an update, stop only Post and save a private snapshot of the current app's
manifest, lock, workspace/patches, modules, YAML, Post package and CLI. Update
release-owned Post/CLI resources from the reviewed new seed, with its new local
Post package version; apply reviewed patch-input changes when needed. Explicitly
run pnpm install to refresh that file dependency, then config-check and restart.
Preserve administrator dependency selections and YAML; never extract a new seed
over an initialized app or synchronize release dependencies on each start.

For rollback, stop Post, preserve current data/key/queue, restore the selected
matching app snapshot, validate and restart. The snapshot is evidence and rollback
material, not a second active source. Never delete/regenerate the vault key or
replay unknown native sends. Record actual deployed revision, paths and checks
separately; building or merging is not deployment.
