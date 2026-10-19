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

The same exact44.0.0 patch additionally guards proven asynchronous lifecycle races,
in source and compiled JS. startClient uses a generation check after versions/thread
support awaits so an old cancelled start cannot initialize sync/pollers, including
when a newer start is active. CapabilityPoller invalidates its generation on stop
and checks after successful/failed fetch before posting another refresh/retry.
SyncApi rejects keepalive startup after stop and ignores a late failed keepalive
before scheduling a retry. The original timeoutSignal logical hunks are preserved
exactly; these are separate cancellation guards, not a larger native deadline.
No SDK upgrade, private runtime fields/wrappers, global timer hooks, unref or forced
exit is used. Post still aborts/drains actual native fetch bodies and awaits actual
startup settlement before releasing Store ownership. Vendor guards prevent future
rescheduling; they do not substitute for I/O retirement. Public-SDK owned subprocess
regressions cover versions/capabilities cancellation, success/failure late completion,
stop/start overlap, keepalive rejection, zero late native requests and natural exit.
Matrix is explicitly a locally patched dependency, not unmodified upstream.

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
https://github.com/soldair/node-qrcode for the Promise/toDataURL API. No guessed QQ share endpoint is introduced. Frontend npm dependencies are
build tools; the deployed artifact contains only compiled local UI resources.
shadcn component MIT and Noto Sans SC SIL OFL notices ship with those resources;
static provenance is in `dist/web/PROVENANCE.txt`.

## QQ credential authorization connector

`@tencent-connect/qqbot-connector` is pinned1.2.0 as a normal **external** runtime
dependency, separately from Satori's message adapter. Its package metadata says
**UNLICENSED**, not MIT; the parent project's license does not relabel it. Preserve
that metadata/notices and its qrcode-terminal dependency in the packaged inventory.
No connector source is copied or inlined into Post's production bundle. Provenance:
[published API](https://www.npmjs.com/package/@tencent-connect/qqbot-connector?activeTab=readme)
and [release metadata](https://registry.npmjs.org/@tencent-connect%2fqqbot-connector/1.2.0).
The callback API disables console QR output; QR/status only are returned to the UI.
The public ESM export is imported dynamically because1.2.0's require target is
misclassified by its package type and fails under Node24.19. The installed package
is unmodified; no private entry or protocol implementation replaces the public API.

Published stop() and success/failure callbacks do **not** prove native response-body
retirement. Post observes this one flow's requests with AsyncLocalStorage plus the
public `http.client.request.start` channel, destroys only its owned requests on
cancel/terminal outcome, and waits for both SDK terminal callback and actual request/
response close. Each owned request has a10000ms full-response deadline; overall QR
user lifetime is120000ms including refresh. Observer subscription, timers, listeners
and ALS are removed at true retirement. Unrelated HTTP(S) requests are excluded.
A short-lived owned loopback HTTP probe verifies channel/ALS coverage before any
provider call and retires its listener/request. Missing coverage prevents connector
start entirely. A default SDK result without expected subsequent native coverage
is refused, not treated as successful authorization. No global HTTPS/timer monkeypatch is used.

Node's built-in HTTP diagnostics channels are **Stability1 Experimental**, even though
the API is public. This integration was verified on the packaged **Node24.19.0** with
actual owned native HTTPS and the exact SDK, including non200 streaming bodies,
cancel, terminal-before-close, unrelated-request isolation and unsubscribe. The
[Node24.19 documentation](https://nodejs.org/download/release/v24.19.0/docs/api/diagnostics_channel.html#event-httpclientrequeststart)
describes the public request field/emission; latest24.x documentation is not proof
for a different runtime build. Runtime upgrades require rechecking this ownership
seam; no stable built-in-channel contract or real QQ scan acceptance is claimed.
