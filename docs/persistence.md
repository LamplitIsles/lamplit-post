# Standalone persistence

Post restores the lightweight #4066 direct SQL table layout, using Node24
`node:sqlite` DatabaseSync. Tables are unprefixed: meta, vault, tokens, identities,
conversations, messages, assets, message_assets, deliveries, sends,
reply_sequences and gaps. Fresh state is stamped application_id0x504f5354 and
user_version2; meta.version remains1. Version2 distinguishes this standalone
format from both deployed framework post_* state and historical unstamped Bun
state. No importer, migration, reset or extra parallel tables are provided.

Ownership acquires the exclusive directory lease and private external key first.
Existing header/version is checked before opening SQLite. The encrypted key-check
is authenticated through that single handle before writable PRAGMAs or DDL.
Fresh DDL comes directly from the historical lightweight store. Supported state
reopens with the same key; wrong/missing keys and foreign state fail closed.

One connection uses the native DELETE journal and synchronous=FULL. Transactions
use synchronous BEGIN IMMEDIATE/COMMIT/ROLLBACK; callbacks contain no I/O or await
gaps. Capture/dedupe, message sequence, asset links and eligible immutable wake
snapshots commit together. Send admission commits its request ledger before
platform I/O; confirmed part receipts persist before another native part.
Unresolved requests reopen as unknown and are never automatically resent.

Assets sync their bytes and directory entry before publishing metadata. Tokens
store only digests; vault uses AES256GCM with purpose/account/reference/version
AAD and an external random key. Configuration pins account/native and conversation
identity. Every API operation rechecks current binding admission.

Native FULL sync-path and SIGKILL tests establish process-crash durability and
actual host sync calls; they do not simulate power loss or guarantee hardware
behavior. Shutdown drains HTTP/platform/domain I/O, disposes Cordis, closes SQLite
and only then releases the lease and wipes the in-memory key.

Optional settings retain this same connection/key/lease during controlled adapter
replacement. No management config tables or second writer are introduced; TOML
remains authoritative. See [settings](settings.md) for save/apply failure recovery.

The explicit offline `connections-convert` command is the sole bounded conversion
of old standalone TOML receiver ownership; it does not change the SQL schema/version.
Its Store open authenticates key/lease but skips runtime initialization, including
NULL-send reconciliation and assets-directory creation. See operator instructions.
Conversation display labels reuse `conversations.name`; they do not participate in
identity pins or admission. Consumer connections live only in TOML, with one sealed
receiver credential per agent. Binding account associations do not grant chat access.

The existing separate private administrator record also retains up to32 browser
session token digests, CSRF values and their original eight-hour expiry. Login and
logout serialize atomic private file replacement and await it before acknowledgement;
management shutdown drains those request jobs. Normal stop clears memory without
revoking retained sessions. Offline administrator reprovision replaces the record,
discarding its sessions. This uses neither SQLite schema changes nor platform,
master-key or agent-token authority. Raw browser session tokens are never persisted.

Name-selected send requests use the existing sends.input column for an accepted envelope:
immutable canonical caller JSON plus resolved account/conversation IDs. ID-selected
requests retain the original flat canonical JSON and key order, so previously accepted
ID requests still reconcile. This adds no SQL schema, migration, alias or configuration
format. Known requests recheck local pinned grants before returning stored/unknown
results; renames never redirect them. Reservation remains atomic before native I/O.

Optional capture-time Message.conversation.name lives only in the original messages.body
and deliveries.body JSON. It uses existing retained conversation metadata (fresh QQ
contact metadata on that observation), introduces no column/version/migration/cache,
and is never backfilled or rewritten on metadata refresh/rename. Old absent-name
snapshots stay byte-identical across restart and deduplication.
