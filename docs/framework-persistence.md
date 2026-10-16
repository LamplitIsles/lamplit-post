# Framework configuration and persistence

Post is a Koishi plugin/service under original Koishi 4.18.11, loader 4.6.11,
Minato 3.7.0 and Node 24. The configured Post entry creates its vault/domain
models, one provider, and its QQ/Matrix forks under that application root.
Offline provisioning uses the same plugin/models with platform connections off.
There is no parallel SQL writer, query emulator, or configuration database mirror.

## Exact provider decision

The provider is `@koishi-ce/plugin-database-sqlite@1.2.2`, backed by Node's native
`node:sqlite`. It uses Minato 3 rather than requiring a framework major upgrade.
Its declared upstream peer is the CE host; upstream does **not** claim support for
original Koishi. This repository deliberately extends only that exact package's
metadata in `pnpm-workspace.yaml`: original `koishi: 4.18.11` is required and the
CE-host peer is optional. Strict peer checking stays enabled. No CE host is
installed or aliased. The lock records this local decision and the dependency
patch; inspect it together with any provider update.

The exact patch `patches/@koishi-ce__plugin-database-sqlite@1.2.2.patch` has SHA256
`1ae8e4247f28bcd02aaccf6a9bbdfdbd5b3c95c7604b53d15711f10b63b3e56d`.
It fixes an observed upstream isolation defect: an unrelated create could resolve
inside another async transaction, then disappear when that transaction rolled
back; unrelated reads could see uncommitted rows. Public CRUD, schema, index and
stats access now joins the provider's existing queue. Active transaction
session/async-context tokens permit owned work and expire after completion.
Stop seals new admission, drains accepted work and closes the connection.
Failed transaction admission/BEGIN supplies a failed session through the existing
callback contract, allowing Minato's lazy initial task to reject instead of waiting
forever, including unsupported nested admission, which still rejects. Failed or expired transaction-bound sessions reject before SQL; an
already-entered callback is never invoked again. Root operations from a stale
async context still queue independently.
SQL generation, models and CRUD implementations remain upstream code.

Minato's lazy transaction callback can originate outside the provider's async
context. The patch therefore supplies an active session token through its driver
transaction callback as well as checking current async context. A captured stale
context does not authorize bypassing a subsequent transaction. Provider tests
cover unrelated CRUD, concurrent transactions/batches, nested upserts, rollback,
error release, schema/index access, stale contexts and shutdown with pending work.
This is a bounded local dependency repair, not a new ORM or upstream support claim.

The MIT provider retains Copyright (c) 2019–present Shigma and Koishijs contributors
and Copyright (c) 2026–present Koishi-CE contributors, with package contributors
thezzisu and Oppenheymu.
Its original source notices and package metadata are retained in the dependency.

## Resources and native durability

The published provider imports two YAML locales. The maintained esbuild build
feeds them through the `yaml` parser into JSON modules at build time. Production
requires no YAML module-loader hook. Other framework and SDK imports remain real
packaged dependencies; packaging copies their dynamic resources and internal
links into a self-contained Node artifact.

The original sql.js-based SQLite 4.7.0 candidate wrote real NODEFS files and
passed SIGKILL/reopen, but its generated filesystem lacked a host sync hook. Its
FULL setting produced no host fsync/fdatasync calls, so it was not adopted.
The selected native provider's FULL/default delete-journal path produces actual
successful fdatasync calls for the journal, parent directory and database, and
committed rows survive immediate SIGKILL/reopen. These are process-crash and
sync-path checks, not a destructive power-loss experiment or a guarantee about
all filesystems/hardware. The implementation does not weaken receiver ACK or
replay unknown native sends to compensate for storage uncertainty.

## Ownership and supported state

The data-directory lock and private external key precede provider startup.
Fresh initialization atomically publishes and syncs the random external key.
The provider's public startup extension stamps a fresh database with application
ID `0x504f5354` and format version 1 before framework model preparation. Reopen
checks the native SQLite header before opening the driver. Missing/wrong external
keys, incompatible/unidentified state and malformed ownership fail closed;
there is no old-data migration or automatic state deletion.

Post domain rows use `post_` model names, distinct from Koishi's users/bindings.
Observation, dedupe, asset links and every eligible immutable delivery snapshot
commit together. The agent/request send ledger commits before native dispatch;
confirmed receipts are saved before another native part. Platform I/O is outside
transactions. Vault ciphertext, agent digests and receiver credentials remain
separate authorities. Token digests have a process-local read projection updated
only after their authoritative mutation commits; offline mutation requires
exclusive ownership.

Configuration changes apply on restart. The normal Koishi loader owns writable
startup configuration; read-only CLI validation calls the same Schema and domain
validators without starting it. The CLI runs its maintained supervisor from the
artifact directory, whose declared HTTP/proxy dependencies avoid legacy manifest
migration. Stop the complete process group, as in the service template. Post
awaits its own native sockets, operations and provider before releasing the lock;
framework disposal alone is not treated as proof that actual I/O has finished.

Provider MIT permission notice (the attribution above applies):

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.
