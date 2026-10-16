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
