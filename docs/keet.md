# Keet runtime and accounts

Post supports the official Linux x64 Keet 4.26.3 application and Core 4.26.4
Production ABI min/max 40. Core's autoupgrade value varies with its configuration
and is not a pinned RPC compatibility value. The official executable, bundle,
addons and identities are operator-supplied and are not included in the Post
artifact. Post does not update them. Use a private, independently prepared
identity directory per account; Core may upgrade an identity when opened.
Preparing or replacing an existing identity, copying backups, and switching a
running gateway are separate operator decisions.

For a reproducible runtime, obtain the official 4.26.3 Linux x64 archive and
verify its SHA-256 before extracting. One preparation method uses `curl`,
`tar`, `7z` and `sha256sum`:

```sh
set -eu
KEET_PREPARE_DIR="$(mktemp -d)"
curl -fsSL https://static.keet.io/downloads/4.26.3/Keet-x64.tar.gz -o "$KEET_PREPARE_DIR/keet.tar.gz"
printf '%s  %s\n' 9b9bcbc91f9d36b00205cdba5fe80493306d5b15fff56e654619d88203db391f "$KEET_PREPARE_DIR/keet.tar.gz" | sha256sum -c -
tar -xzf "$KEET_PREPARE_DIR/keet.tar.gz" -C "$KEET_PREPARE_DIR"
mkdir "$KEET_PREPARE_DIR/extracted"
7z x -y -o"$KEET_PREPARE_DIR/extracted" "$KEET_PREPARE_DIR/Keet.AppImage" 'resources/app/core-worker.bundle' 'resources/app/node_modules/*'
sha256sum "$KEET_PREPARE_DIR/extracted/resources/app/core-worker.bundle" "$KEET_PREPARE_DIR/extracted/resources/app/node_modules/bare-sidecar/prebuilds/linux-x64/bare"
```

The worker SHA-256 must be `a20f0d1945c40fcc29f37a45d9967c86cd129e730a19fbe726b7c67b613840d3`;
Bare must be `1bfdfbc3a35280a290f0e1172bc03eb1ff9287b9483649b9da9de3b3c2225a14`.
Preserve the entire extracted `resources/app/node_modules` tree beside the
bundle. The current bundle's manifest has an empty addons array even though
Core needs 23 native addons, so do not use the manifest to choose files. Post
checks the pinned worker and Bare hashes and the required addon paths before
starting. Make the runtime directory private and read-only to the Post process;
remove only the temporary preparation directory after inspecting and installing
the operator-owned runtime. The official archive is available from
[Keet downloads](https://keet.io/download/) and
[the pinned release directory](https://static.keet.io/downloads/4.26.3/).

Set top-level `keet_runtime_dir` to the extracted `resources/app` directory. Add
an account with `platform = "keet"`, a stable `id`, pinned Keet member
`native_id`, and its operator-provisioned `identity_dir`; optionally add `name`.
Paths resolve relative to the TOML file. Do not set `credential`, `homeserver`,
or `share_url` on a Keet account. Exactly one binding owns the account, and
that binding must contain no Keet scopes. The account appears to its enabled
agent even if it has no conversations.

The enabled binding gives its sole agent access to rooms Core currently confirms
as readable and joined and to accepted direct conversations with the exact
peer. Broadcast rooms use the same membership check; sends additionally require
Core write authority. Exiting, losing access, or a pending direct request stops
access at the next operation or delivery check. Temporary Core failure holds
pending deliveries; confirmed revocation cancels them. The settings administrator
can inspect membership and handle invitations even when the binding is disabled.
Names select conversations but do not grant access. First subscription frames are
historical and do not wake the agent; unresolved native submissions are never
resent automatically.

Each identity uses a persistent `.keet-sidecar.lock`, shared with keet-for-agent,
and Post holds the kernel lock until the actual worker exits. Never run two
owners on the same identity. Keep runtime paths, identity paths, invitation links
and raw platform credentials private. The browser cannot create identities or
change host paths. Update consumers that strictly validate the Post v1 platform
enum before configuring a Keet account; an older consumer can reject the entire
account list. Merge or package creation does not deploy or switch an identity.
