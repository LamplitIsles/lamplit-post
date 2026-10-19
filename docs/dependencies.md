# SDK dependencies and exact repair

Satori4.6.0/Cordis with HTTP0.6.3 and QQ adapter4.14.0 provide the QQ protocol,
REST and WebSocket implementation. Matrix uses matrix-js-sdk44.0.0 with an account
access token. Koishi, its management plugins and Minato are absent from runtime.

Matrix44's `timeoutSignal` in src/http-api/utils.ts and lib/http-api/utils.js
creates a referenced setTimeout and never clears it after HTTP completion/abort.
Sync supplies 80/110-second deadlines, keeping a stopped Node process alive.
The exact patch `patches/matrix-js-sdk+44.0.0.patch` replaces that ponyfill with
Node24 AbortSignal.timeout in source and compiled JS. `anySignal` still normalizes
abort reasons through its own AbortController. Post's full-response/native
operation deadline and stop signal remain in fetchFn; this patch does not replace
them. No private client.http wrapper or global timer override is used.

The standard patch-package postinstall applies the checked-in exact-version
patch on npm ci. Packaging repeats a production npm ci from package-lock, applies
the patch and inventories actual files/dependency resources. Runtime never patches
or installs packages. revision.json records the patch SHA256; artifact-manifest
records the changed SDK bytes. An SDK change requires retesting timeout/abort,
repeated normal requests and natural process exit.

Upstream source: https://github.com/matrix-org/matrix-js-sdk/tree/v44.0.0
Matrix source retains Matrix.org Foundation copyright and Apache2.0 license.
Satori/Cordis/QQ retain upstream MIT notices; TOML parser smol-toml retains its
BSD3Clause license. All dependency notices ship with their package resources.

Settings add node-qrcode1.5.4 (MIT) for local PNG QR encoding; jsQR/pngjs are
verification-only dependencies for decoding the generated image in tests. See
https://github.com/soldair/node-qrcode for the Promise/toDataURL API. No QQ share
endpoint or additional platform SDK is introduced. Frontend npm dependencies are
build tools; the deployed artifact contains only compiled local UI resources.
shadcn component MIT and Noto Sans SC SIL OFL notices ship with those resources;
static provenance is in `dist/web/PROVENANCE.txt`. The Matrix patch above remains
byte-identical.
