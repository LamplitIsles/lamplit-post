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
agents = []
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

Open the configured origin. New login sessions expire 30 days after login without
renewal on use; previously issued sessions retain their original expiry. They use
HttpOnly SameSite=Strict cookies. Unexpired sessions survive normal process restart
and deployment within the same installation; restart does not extend their expiry.
The existing private administrator record stores only salted token digests, CSRF
values and expiry, with at most32 sessions. Login/logout persistence is awaited
before success; logout and offline password reprovision revoke retained sessions.
Sessions issued by older ephemeral versions cannot be recovered, so the first
upgrade may require one login. Login
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
store. A registered agent token can list an empty account set before any binding
is added or after the final binding is removed. Identity alone does not permit raw
uploads, history, sends or asset reads: those retain grant checks. Fully paused
bindings still deny machine HTTP access. The browser session does not authorize
machine MCP/assets, and an agent Bearer cannot administer Post.

Choose one of this agent's accounts or add its own account. QQ's primary path is **扫码连接 QQ**:
scan the provider authorization QR in mobile QQ, then explicitly save the account
and wait for its connection. Find chats and save their grants separately. The
connector supplies App ID/AppSecret to Post in server memory;
only the QR/status/App ID reach the browser. This is credential authorization, distinct
from the secondary configured-bot share QR. Manual App ID/AppSecret remain an explicit
advanced option. Authorization lasts120000ms including QR refresh; cancel, expiry,
logout and shutdown discard uncommitted credentials and retire actual native requests.
A durable save acknowledgement does not consume the authorization: within the original
lifetime, a failed apply can explicitly retry the same server-held credential. Only
terminal apply success consumes it; cancel, logout and expiry still erase it immediately.
An already accepted apply owns its captured credential and continues to its truthful
outcome if authorization expires or is cancelled; a new attempt requires authorization.
No real QQ enrollment is performed by automated acceptance.

For Matrix, enter user ID/homeserver/access token and choose **验证账号** before
saving the account and waiting for its connection. The existing SDK verifies
whoami and reads joined rooms/metadata without
starting sync, pinning identity, storing a credential or granting access. Encrypted
rooms are shown as unsupported, and a successful empty list differs from a failed
request. Editing identity/address/token invalidates the result and cancels the prior
request. Leaving an existing-account replacement blank uses its vaulted credential
server-side. Cancel discards the draft. Verification/listing share one configured
operation deadline and retire all request I/O before releasing ownership.

After the account connection is ready, find chats and explicitly save selected grants
and wake rules. A first save can associate an account with its agent with an empty
chat scope; leaving after a successful apply retains the account without granting chats.
When editing an existing account, preserve its saved scopes and wake rules until the
operator explicitly saves changes to them. Discovery can be retried or deferred.

QQ candidates distinguish locally
observed conversations from configured pins, not a complete upstream directory. Manual
native IDs are explicit and are not claims of verification. Selecting an observed/verified QQ private contact and explicitly saving grants only
that contact's native peer. Receipt/discovery alone never grants access. Existing empty
or mismatched private rules remain denied on load/open; use **授权此私聊** after
reading known contacts, or explicitly reselect the contact, then save. Cancel changes
nothing. Manual/unverified QQ and Matrix private conversations retain explicit peer
ID admission; Matrix semantics are unchanged. Room visibility is not an agent grant. The independent consumer connection owns one receiver URL and write-only secret per
agent; chat bindings never ask for them. Edit the consumer connection outside the
chat wizard; a blank secret preserves the existing one. Cancelling discards the draft. Required inputs remain scrollable on short
normal-zoom desktop/mobile viewports, without a footer painted over them.

Save first validates optimistic version, references and immutable pins, closes old
intake and retires actual old I/O. Only then does it update the sealed vault and
privately atomically fsync/rename the TOML. The HTTP acknowledgement explicitly says
`saved: true, applied: false, state: applying`; this is durable local persistence, not
platform readiness. Replacement startup continues as one tracked task under the same
Store/key/lease. A competing mutation is rejected promptly, not queued behind connect.
If old retirement cannot finish within the normal local response allowance400ms, this
attempt returns unsaved/draining and only retires/reopens the unchanged runtime; it
never silently writes the rejected proposal later. Slow disks are not a realtime guarantee.

The owner target is local acknowledgement p95<=500ms for a declared finite20 valid
sequential uncontended samples on supported local storage, with median/p95/max and all
values reported. Provider readiness is measured separately. Visible browser feedback
target is100ms. Do not improve those metrics by removing fsync, weakening drain or
counting a queued/received proposal as saved.

Authenticated GET `/api/status` is nonblocking during connect. Settings/status separate
`accepted_version` (the attempted durable save), `current_version`/`version` (current
TOML authority) and `active_version` (actually ready runtime). `applied` refers to the
latest successful apply and becomes true only after readiness. Version digests describe
TOML bytes, not secret changes. A credential-only rollback can leave all three digests
equal while the latest attempt reports saved:false/applied:false and old ready:true.
The GUI follows this state and displays connect, recovery, applied or failed outcome.
Bodyless status/authorization reads preserve their HTTP keepalive connection even when
Node completes parsing after the synchronous response handler. Declared unread,
oversized or aborted bodies are still retired; disconnect cancellation and request
bounds remain in force. On response loss or an
empty/nonJSON error, read the existing version/status before deciding what to do;
never automatically re-POST. A502/reset does not prove that nothing was saved.

With B=`timeout_ms` (default30000ms), each replacement/restore connect+ready attempt
has total B in addition to existing per-I/O deadlines. Retirement's outcome-reporting
budget R=B+1000ms includes the existing WebSocket grace. Normal status budget is R+B
plus measured local persistence; successful recovery at most2R+2B plus persistence;
full failed/recovered reporting at most3R+2B plus persistence (default153000ms). There
is one recovery attempt, no automatic loop. If true cancellation retirement exceeds
R, state becomes failed_draining and all mutations stay blocked; Store/key/lease are
retained until actual settlement, never forcibly released to satisfy reporting time.
Matrix draft verification/listing also has total B; its response socket allows that
bounded operation, while saved settings no longer await native connect in HTTP.

Failed apply attempts restore previous TOML/vault/runtime when possible. The original
accepted version remains visible alongside restored current/active versions and
`failed_recovered`; the earlier saved acknowledgement is not rewritten as never saved,
and old readiness is not called applied for the new version. If restore fails,
authenticated settings remain available without claiming a ready runtime. Atomic TOML
and vault transactions remain separate resources: crashes can leave a durable config
whose native readiness is unestablished. On reopen validate the authoritative state
normally; no persistent operation registry or configuration mirror is introduced.
Back up TOML/vault/external key together while stopped. Never reset the database/key
to recover a connection failure.

Minimal structured `settings_stage` events contain operation/version, stage,
elapsed_ms and safe outcome only. They contain no credentials, headers, URLs, room or
message IDs. Native SDK request logging remains quiet. These events classify slow
validation/drain/persist/connect/recovery without inventing a cause for the earlier
production Matrix latency or original live save outcome, both still unknown.

Cancel discards unsaved changes; it does not remove a successfully applied account.
Pause removes agent access and cancels ineligible queued
wakes during admission rechecks. Unbind revokes that connection's scopes without
deleting history; removing the final binding retains the independent consumer connection and token. No
unknown send is automatically repeated. Delivery snapshots retain original
bodies/destinations, including across receiver edits and restart.

For QQ's “添加机器人”, paste the official profile/share URL you obtained from QQ.
Post only accepts HTTPS links on `qun.qq.com`, `bot.q.qq.com`, or `q.qq.com`, with
no userinfo, fragment or credential-like fields. It does not fetch the URL or
follow redirects. QR generation encodes that exact normalized link locally.
Generation, scanning, adding and granting are separate events. The UI cannot
confirm adding, and never grants agent access from a QR action. Host allowlisting
checks URL form; it cannot independently attest a pasted link's target identity.

Configured-bot share links and scan credential authorization are separate actions.
The latter uses the published
[@tencent-connect/qqbot-connector1.2.0 public callback API](https://www.npmjs.com/package/@tencent-connect/qqbot-connector?activeTab=readme),
not a guessed App ID URL or personal QQ protocol. See dependency provenance and the
Node24 native-request ownership qualification in [dependencies](dependencies.md).

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

If a newly verified account fails later during startup, rollback preserves its immutable identity and conversation pins. Discarding the wizard or reloading does not delete those pins. A subsequent successful Matrix identity check or QQ credential authorization can recover the original account ID only when that ID is absent from the current configuration. Candidates reuse existing conversation IDs. Configured accounts must be selected explicitly and retain their identity, homeserver and credential reference guards. Recovery does not restore grants, attach historical vault references, issue tokens or reveal secrets: supply a current credential and explicitly save the desired scope again. The submitted wizard draft remains available through terminal apply failure; success or explicit cancellation clears its credentials.

The exact Matrix44 vendor patch also prevents late SDK startup and capability/keepalive polling after cancellation. It preserves the original timeoutSignal hunk and all native deadlines. Native body retirement remains owned by Post; cancelled-start public-SDK and application probes must exit naturally before cleanup is accepted. See `docs/dependencies.md` for the patch boundary.

Each configured account belongs to exactly one distinct agent through existing
`bindings.account_ids`, including disabled bindings and accounts with zero chat grants.
Several bindings may reference an account only for that same owner. An agent may own
multiple accounts on the same platform. The home and picker show only the selected
agent's accounts; there is no global unassociated attachment pool or account sharing.
Saved ownerless/shared configurations fail validation: an operator must explicitly
choose one owner, without inventing credentials or granting chats. Retained accounts
cannot transfer owners through settings. Global inventory remains administrator-only.

Saving a new account associates it with the selected agent atomically; draft verification
checks only account identity/credential/pins, never ownership or admission, and does not
persist or start an account. An authorized QQ draft is still awaiting save. Clearing chat
grants retains account ownership and shows **未授权聊天**. **撤销聊天授权** preserves
accounts/history; **删除账号** is a separate explicit confirmation removing the connection,
credential and scopes, while keeping identity pins/history and other accounts. There is
no permanent owner registry after an explicit full account deletion. Editing one account
in a multi-account binding preserves its other accounts and scopes. Collapsed rows retain
platform icons, account names and status; **详情与编辑** contains chat/wake/identity detail
and actions. Native QQ `share_url` remains a bot invitation link, not account sharing.

Conversation names are editable in the selected-chat step. The stored name takes
priority over later platform metadata; reload needs no upstream lookup. Existing
nonempty names are preserved, including names that resemble IDs. IDs and
pins remain authoritative. When a conversation has no usable name, Post shows a
stable generated label such as **QQ 私聊 1**; this label does not claim to be the
contact's nickname and can be replaced by the administrator. There is no name polling.

QQ search is the locally observed/configured directory, not a complete upstream
QQ group list. Save/connect the bot first, add it to the group and @mention it there,
then refresh available chats and explicitly select a grant. Receiving that event
only creates an observed candidate; it does not authorize or wake any agent. Search
by available name or this App's scoped openid, not the public numeric group number.
Unsaved authorization drafts cannot receive these events. Transport errors and an
empty local list are separate states. The exact main QQBot4.14 adapter has no
getGuildList; its QQGuildBot sibling lists channels, not QQ groups. This does not
assert that Tencent has no other APIs. The supported event includes group_openid:
[official native mention event](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html).

QQ candidates, selected chats, confirmation and saved details distinguish **群聊**
and **私聊**. A first observation of a new group tries the public known-group
metadata method before capture when no other inbound work is queued, within the
smaller of the native deadline and one second. An existing queue skips the lookup;
failure, timeout or newly queued work ends it. Post then saves a generated label
and still archives the message in order.
Private names can come from the first observed sender metadata. Existing nonempty
names, including generated and administrator-set names, are never overwritten by
later lookups. Names reuse the existing conversation store, with no startup fetch,
polling or extra cache. OpenIDs stay secondary and remain searchable; names never change pins or grants.
Authorized consumers use current names through the v1 conversation tools. New events
and history snapshots carry the capture-time name; older snapshots may omit it and
renames never rewrite them. Observed candidates
with no explicit chat/peer grant remain inaccessible to consumers.

QQ history remains locally observed. Authorized ordinary group messages that reach
Post are archived and readable even when only native @ messages wake the agent.
The adapter already handles `GROUP_MESSAGE_CREATE` under the existing bit25
subscription. Tencent's receive-all capability determines whether it supplies those
events; Post cannot recover messages never supplied or promise full group history.
The finite `native_event` stderr field distinguishes ordinary/@/direct arrival
without logging content or identifiers.
