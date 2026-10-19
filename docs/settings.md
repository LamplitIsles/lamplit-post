# Agent settings

Settings are an opt-in static Svelte 5 application served by the standalone Node
process. The default headless command and machine MCP/asset authentication stay
available. No services are installed or changed by building this artifact.

Use a new private standalone installation, never the current managed app's state.
Start with a private TOML document (0700 parent, 0600 file), including:

```toml
data_dir = "./data"
master_key_file = "./master.key"
hostname = "127.0.0.1"
port = 18787
accounts = []
bindings = []

[settings]
port = 5140
origin = "http://127.0.0.1:5140"
admin_file = "./administrator.json"
```

With the process stopped, provision the single administrator from private stdin:

```sh
node dist/cli.cjs admin-provision --config /private/post/post.toml < /private/password
node dist/cli.cjs serve --config /private/post/post.toml
```

Use a password of 12–1024 characters. Provisioning requires exclusive ownership;
it initializes fresh standalone state if necessary. Repeating it offline replaces
the password. The private salted scrypt record is separate from the external
master key, encrypted platform/receiver secrets and agent tokens. Keep it outside
the data directory and distinct from the config/key. No online first-user setup,
recovery URL or default password exists.

Open the configured origin. Login sessions expire after eight hours, use HttpOnly
SameSite=Strict cookies, and are discarded on process restart or logout. Login
allows five attempts per minute across the loopback listener. For later Caddy
HTTPS use a fixed HTTPS `origin`; the cookie then includes Secure. Preserve that
Host header when proxying to loopback. Post does not trust forwarded headers.
No Caddy configuration or deployment is included here. The settings port is
independent of the private machine API port; do not expose either casually.

Register the actual consumer using its stable agent ID, display name, fixed
receiver URL and separate receiver Bearer secret. There is no external catalogue
or fabricated agent list. Registration starts with zero grants. Explicitly issue
a machine token in consumer connection settings; it is shown once and rotates
any previous token. Copy it directly to the intended consumer's private secret
store. The browser session does not authorize machine MCP/assets, and an agent
Bearer cannot administer Post.

Choose an existing shared account or add a QQ official bot App ID/AppSecret or
Matrix account ID/homeserver/access token. Enter secrets only in password fields.
They are written to the existing sealed vault and never returned in settings
responses. Leaving a replacement field blank retains the existing credential.
A new binding needs its own receiver credential; expand its consumer connection
fields. Account credential changes reconnect all uses of that account, while
chat grants remain independent. Identity/homeserver/credential references are
immutable once configured; create a distinct account instead of remapping it.

Grant chats, then configure wake rules separately. QQ candidates distinguish locally observed conversations from configured pins
without captured messages; they do not constitute a complete QQ directory. Matrix discovery reads joined rooms and their metadata through the
existing account SDK; encrypted rooms are disabled. Lists are bounded (200 local
conversations, 100 Matrix rooms); observed state does not grant access. New
accounts must first save/connect before platform discovery is available, so the
initial draft can use explicit app-scoped native IDs. Manual entries are not
claims of upstream verification. Private conversations require explicit peer IDs;
QQ private scopes must include that same user's openid. Post verifies Matrix
joined plaintext scope again when an agent uses it.

Save waits for controlled apply. Old intake and actual domain/platform I/O drain
before replacement adapters start. The process retains the same SQLite handle,
external key and lease through the change; it never opens a second writer.
Saves serialize and require the current config hash. Invalid references, stale
versions, changed immutable paths, and persisted identity/conversation remapping
are rejected before modifying files, secrets or stopping the runtime. Changes to
the file outside the UI require an offline restart; they cannot be overwritten
using an old running view.

The TOML write uses a private same-directory tempfile, fsync and atomic rename.
On failed readiness, Post attempts to restore the previous TOML, vault values and
runtime. The response distinguishes `saved` from `applied`; failure is never
reported as active settings. After trusted administrator/configuration/state
acquisition, a native transport startup failure keeps authenticated settings
available with `state: failed`, safe `error: unavailable`, and no machine URL.
The CLI reports `settings_ready: true` separately from runtime `ready: false`,
with a null machine URL and unhealthy runtime status. `ready: true` requires
SDK startup, a bound machine listener and a healthy runtime. Correct the credential
through the existing binding editor and save to retry under the same Store/key/lease.
Configuration, administrator-file, key, ownership and persisted pin failures
remain fatal. Shutdown cancellation still drains startup before releasing
ownership. Do not delete the database/key to recover. Atomic file writes and vault
transactions are separate resources: a process crash during apply can leave a saved configuration whose
upstream readiness has not been established. On reopen it is validated normally;
back up TOML, vault and external key together while stopped.

Cancel discards a draft. Pause removes agent access and cancels ineligible queued
wakes during admission rechecks. Unbind revokes that connection's scopes without
deleting history; the final empty binding retains the registered consumer. No
unknown send is automatically repeated. Delivery snapshots retain original
bodies/destinations, including across receiver edits and restart.

For QQ's “添加机器人”, paste the official profile/share URL you obtained from QQ.
Post only accepts HTTPS links on `qun.qq.com`, `bot.q.qq.com`, or `q.qq.com`, with
no userinfo, fragment or credential-like fields. It does not fetch the URL or
follow redirects. QR generation encodes that exact normalized link locally.
Generation, scanning, adding and granting are separate events. The UI cannot
confirm adding, and never grants agent access from a QR action. Host allowlisting
checks URL form; it cannot independently attest a pasted link's target identity.

The official [QQ documentation](https://github.com/tencent-connect/bot-docs/blob/main/docs/README.md)
describes profile sharing. It does not establish an App ID URL formula. The
inspected Satori QQ 4.14 and official Node SDK 1.0.5 do not establish a public
`generate_url_link` contract; community endpoint names are not used as an API.
This implementation therefore labels the manual source and supports a genuine
operator-provided link instead of guessing a URL or enrolling credentials by QR.

Development uses Node 24 and npm:

```sh
npm ci
npm run dev --prefix web
npm run check --prefix web
npm run typecheck
npm test
npm run build
npm run package
```

The focused real Chromium principal-switch regression uses an installed
`agent-browser` CLI against the owned SDK fixtures and packaged backend:

```sh
POST_BROWSER_CHECK=1 node scripts/test.mjs tests/settings-browser.test.ts
```

It is opt-in so browser tooling is not a runtime/package dependency. Backend
acceptance includes the extracted-CLI cold-start failure and repair regression.

The dev server listens on 5140 and proxies `/api` to 5141. For interactive
development, run Post with `settings.port = 5141` and
`settings.origin = "http://127.0.0.1:5140"`, then run the dev command. The proxy
preserves the browser Host/Origin. Alternatively build and use the actual settings
server at its configured origin.
Origin/Host protection also applies in development; arbitrary localhost origins
are not accepted. Production artifacts contain the local hashed JS/CSS/font and
brand files under `dist/web`; no runtime npm or CDN is needed.

The UI reuses only shadcn-svelte presentation components and neutral style rules
from the approved disposable prototype (5531f228). Its model and simulated data
are not used. Component provenance/license and font provenance ship in the static
bundle. Backend tests use owned SDK fixtures and receiver endpoints. Real QQ/Matrix
account permissions and actual third-party add behavior require later operator
acceptance; no live account, deployment or installed service is involved.
