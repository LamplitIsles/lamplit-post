# Standalone Post operations

Use Node 24. Extract the complete reviewed archive into a new private directory.
Record `revision.json`, `artifact-manifest.json` and archive SHA256. A dirty-tree
artifact is development evidence. Do not extract over an initialized installation.

This artifact runs a headless backend. There is no browser administration,
plugin market, supervisor, administrator account or online configuration service.
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
  --ref partner-receiver --account partner --kind receiver < /private/receiver-secret
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
Bearer on every request. The CLI prints readiness only after SDK startup and
listener binding. SIGINT/SIGTERM abort and drain actual I/O before releasing
the database/key lease. Startup never installs dependencies or downloads code.
The [service template](../deploy/lamplit-post.service) is inert until an operator
selects paths/user and explicitly installs it.

`incompatible_state` means unsupported format. `conflict` can indicate another
owner or persisted identity mismatch. `unavailable` includes vault authentication
failure. Inspect the owner before stale-lock recovery; never delete a key/database
to make startup succeed. Raw upstream errors/messages are intentionally absent
from logs. Reconfigure only while stopped and validate before restarting.

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
