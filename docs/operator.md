# Standalone Post operations

Use Node 24. Extract the complete reviewed archive into a new private directory.
Record `revision.json`, `artifact-manifest.json` and archive SHA256. A dirty-tree
artifact is development evidence. Do not extract over an initialized installation.

This artifact runs a headless backend by default. Optional authenticated
[agent settings](settings.md) serve a local static UI with a separately provisioned
administrator. There is no plugin market or supervisor.
The current deployed managed app/unit is a different artifact and requires a
later explicit operator handoff. Do not point this artifact at its database or
replace its configuration/key. Merge alone does not deploy anything.

## Configuration and offline enrollment

Copy `examples/post.toml` to a private config directory and edit verified account,
conversation and receiver identities. Paths resolve from that file's directory,
independently of the process cwd. The sole parser accepts TOML; unknown fields,
unsafe endpoints, duplicate identities and conflicting conversation IDs fail.
Use API18787 for the current-host example to avoid CFL8787. Loopback is the
only listener host; use a deliberate TLS/private-network boundary beyond it.

```sh
node /opt/post/dist/cli.cjs config-check --config /etc/post/post.toml
node /opt/post/dist/cli.cjs --help
```

These read-only commands create no data directory, key, lock or database.
Config must be a regular file and its directory/file must not be writable by
other users. The data directory and external key must be private (0700/0600).
The key must remain outside the data directory. Fresh initialization creates it
atomically and syncs it; losing the key for existing state is an error.

Stop the standalone process before offline provisioning. Pipe secrets from a
private source to stdin; never put secret values in TOML, argv or shell history:

```sh
node /opt/post/dist/cli.cjs credential-put --config /etc/post/post.toml \
  --ref qq-platform --account qq-main --kind platform < /private/qq-secret
node /opt/post/dist/cli.cjs credential-put --config /etc/post/post.toml \
  --ref matrix-platform --account matrix-main --kind platform < /private/matrix-token
node /opt/post/dist/cli.cjs credential-put --config /etc/post/post.toml \
  --ref partner-receiver --account cfl --kind receiver < /private/receiver-secret
node /opt/post/dist/cli.cjs token-issue --config /etc/post/post.toml --agent cfl > /private/agent-token
```

Create the token delivery file with restrictive umask/permissions. Token issue
prints the new token once and rotates the previous token; all other output is
safe status/category data. Platform credentials, receiver secrets, external vault
key and machine agent tokens are separate authorities.

## Start, stop and diagnose

```sh
node /opt/post/dist/cli.cjs serve --config /etc/post/post.toml
node /opt/post/dist/cli.cjs status --config /etc/post/post.toml
node /opt/post/dist/cli.cjs token-revoke --config /etc/post/post.toml --agent cfl
```

Status and offline mutations refuse the serving lease. During serve, `/healthz`
exposes safe readiness/backlog categories. MCP and assets require the agent
Bearer on every request. The CLI reports `ready: true` only after SDK startup,
machine listener binding and a healthy runtime. Opt-in management availability
is reported separately as `settings_ready: true`; native startup failure can
leave settings available with `ready: false` and a null machine URL.
SIGINT/SIGTERM abort and drain actual I/O before releasing
the database/key lease. Startup never installs dependencies or downloads code.
The [service template](../deploy/lamplit-post.service) is inert until an operator
selects paths/user and explicitly installs it.

`incompatible_state` means unsupported format. `conflict` can indicate another
owner or persisted identity mismatch. `unavailable` includes vault authentication
failure. Inspect the owner before stale-lock recovery; never delete a key/database
to make startup succeed. Raw upstream errors/messages are intentionally absent
from logs. Headless file edits require a stopped process and validation before restart.
Opt-in settings serialize and validate protected saves before controlled apply.

Asset helper:

```sh
POST_TOKEN_FILE=/private/agent-token node /opt/post/dist/cli.cjs asset-upload \
  --url http://127.0.0.1:18787 --file ./picture.png
```

## Backup and update

Stop the entire standalone process and verify ownership released. Save a private
snapshot of data (database and assets), external key, TOML, artifact and revision.
Restore matching standalone snapshots only; do not merge data or create a second
writer. Unknown sends remain unresolved on reopen, and receiver retry snapshots
retain their original destination/body. Back up the external key separately with
access controls; token revocation does not replace the encryption key.

The standalone format is application ID0x504f5354/user_version2, unprefixed domain
tables plus meta version1. The previous framework post_* format and older Bun
files lack this exact header/version contract and are refused. No migration,
compatibility parser or reset operation is included. Any future actual transition
from the current managed installation must decide fresh state separately and
preserve the installed files until the operator authorizes that transition.

## Explicit consumer connection conversion

This release accepts only the `agents` + `bindings.account_ids` TOML format.
Every configured account requires exactly one distinct agent owner via account_ids;
multiple bindings for that same owner and multiple same-platform accounts are valid.
Ownerless or cross-agent-shared accounts fail before writable startup or conversion.
For an existing conflict the operator must explicitly select one owner and remove losing
associations/scopes, or supply separate actual platform accounts. No owner is inferred,
credential duplicated, live configuration inspected by tests, or ownership migrated.
Existing single-owner documents and all storage formats remain unchanged. Removing the
last association while retaining its account is invalid; clearing chat grants retains
ownership. Full account deletion is separate; retained-account transfer is rejected.
For an existing standalone binding-owned receiver document, stop Post and explicitly
run the bounded offline command against that installation, using its existing key:

```sh
node /opt/post/dist/cli.cjs connections-convert --config /etc/post/post.toml
node /opt/post/dist/cli.cjs config-check --config /etc/post/post.toml
```

This is a separate operator transition; building or merging does not execute it.
The command takes the real ownership lease, authenticates the existing vault and
never starts adapters or reconciles unresolved sends. For each agent, all old URLs
and decrypted receiver secrets must agree; otherwise it rejects before mutation
without revealing either value or choosing a winner. Platform credentials, tokens,
key, administrator, pins, history and delivery snapshots remain unchanged. Associations
are derived only from existing scopes; empty historical registration placeholders
stay empty, and globally configured accounts are never invented as associations.

Fresh agent-owned receiver refs are staged additively; old authority remains usable
until a privately synced atomic TOML rename commits. Obsolete binding-owned receiver
refs are then removed. If interrupted before commit, rerun this explicit command;
after commit the same command validates new credentials and finishes bounded cleanup.
Repeating it reports `already_converted`; normal startup does not convert or replay.
A failed/uncertain command does not authorize retrying any native send. No additional
backup prerequisite is imposed by this conversion.

## QQ send diagnostics

`reply_to_message_id` identifies an admitted **Post message**, in the same account
and conversation. A native QQ message ID is not a Post reference. Post rejects a
QQ reference target at least295seconds old before submission; the safe MCP error
distinguishes an expired reference from a missing or mismatched target. It does not
silently choose another anchor or turn a reference reply into an ordinary send.

QQ send failures emit a bounded `qq_send_failure` category/stage with numeric HTTP
status and native error code when the actual SDK supplies them. Missing/nonnumeric
values are `null`. No response text, bodies, message/account/request IDs, URLs,
headers or credentials are logged. A generic `platform_rejected` alone does not
establish a permission, quota or passive-window cause. Definite4xx refusal remains
failed; ambiguous native handoff remains unknown. Reconcile an existing request ID
and immutable content to read its durable result; do not invent a new request ID
or replay an unknown send. Previously discarded provider details cannot be recovered
by this logging change, and automated fixtures do not establish a live send repair.

QQ ingress diagnostics use content-free JSON on stderr. `qq_inbound` records have
`stage` (`sdk_capture`, `observation`, `receiver`), `type` (`group`, `direct`) and
finite `category` values. SDK categories are `queued`, `stopped`, `capacity`,
`capture_failed`; observation categories are `archived`, `duplicate`, `self`,
`catchup`, `observation_failed`. Committed observation records count `bindings`,
`inactive`, `disabled`, `scope_missing`, `peer_denied`, `admitted`, `wake_none`,
`wake_direct`, `wake_mention`, `wake_reply`, `wake_alias`, `deliveries_created`.
These counts distinguish absent grants/peer admission from absent wake rules;
archiving a candidate does not grant access. Failed transactions report failure,
never tentative delivery counts. Receiver categories are `accepted`,
`http_rejected`, `unavailable`, `cancelled`, `scope_revoked`, `receiver_changed`,
with numeric/null `http_status`, dispatch `attempt` and `elapsed_ms`. HTTP failure
retains existing pending/reconciliation behavior; diagnostics add no sends/retries.

`post_readiness` emits a startup canary and deduplicated snapshots on existing
health reads/QQ lifecycle transitions. `category` is `healthy`, `degraded` or
`stopped`; counts are `qq_total`, `qq_ready`, `matrix_total`, `matrix_ready`,
`pending`, `held`, `backlog_full` (0/1), `capture_errors`, `dispatch_errors`,
`other_errors`. Pending alone does not make health false. Readiness counts explain
platform/error/backlog conditions; they cannot prove receipt of an absent message.
Neither event includes identifiers, names, message content, URLs, headers,
credentials or upstream error strings. No telemetry polling or correlation store
is added. Observe only authorized existing activity; do not replay to obtain logs.

SDK capture records additionally expose `native_event`, strictly one of
`GROUP_MESSAGE_CREATE`, `GROUP_AT_MESSAGE_CREATE`, `C2C_MESSAGE_CREATE`, `other`.
Arbitrary native event strings are never logged. This distinguishes supplied ordinary
group events from @ events; it does not enable Tencent's receive-all permission.
