# Post consumer contract v1

Authority: FlickNote #4066. `index.ts` is the canonical executable schema. This directory is versioned with the repository; the CONTRACT_READY commit pins v1 for CFL #4067. Changes require Orc coordination before implementation. No platform credential, server-local asset path, arbitrary URL fetch, or agent session is exposed.

## Authentication and transport

The operator configures a fixed Post base URL, one agent Bearer token, and a separate fixed receiver URL/Bearer secret. Send `Authorization: Bearer <agent-token>` on **every** MCP and asset request. Tokens are separate from upstream credentials. Use TLS outside loopback. No browser cookie auth. No redirects for assets or notifications. Unauthorized returns HTTP 401; invisible resources return 404 without revealing existence.

MCP uses official SDK Streamable HTTP at `/mcp`, stateless (no persistent session ID required), JSON responses. Exactly seven tools in `ToolInputs`; successful CallToolResult has `structuredContent` equal to the ToolOutputs value and one text content containing the same JSON. Tool failures have `isError:true`, structuredContent and text equal to ToolError. Malformed MCP envelopes follow SDK JSON-RPC errors. Transport failure after send is unresolved: repeat the **same** request_id/content to reconcile; never invent a new ID for blind retry.

## Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| list_accounts | `{}` | `{items: Account[]}` |
| list_conversations | `{account_id,limit?,before?}` | `{items: Conversation[],next_before:string|null}` |
| get_conversation | `{account_id,conversation_id}` | `Conversation` |
| list_members | `{account_id,conversation_id,limit?,before?}` | `{items: Member[],next_before:string|null,capability}` |
| read_messages | `{account_id,conversation_id,limit?,before?}` | `{items: Message[],next_before:string|null}` |
| get_asset | `{asset_id}` | `Asset` |
| send_message | `{conversation_name,account_id?,platform?,conversation_type?,request_id,content,reply_to_message_id?}` or ID fallback `{account_id,conversation_id,request_id,content,reply_to_message_id?}` | `SendResult` |

Prefer an exact current **conversation_name** (group/contact display name) for send_message.
It selects only this authenticated agent's granted/admitted conversations; names confer
no authority. Optional account_id/platform/conversation_type disambiguate. No match is
not_found; multiple matches are conflict with bounded JSON-escaped authorized choices.
No fuzzy matching, aliases or most-recent selection. Supply exactly one selector; keep
account_id + conversation_id for unnamed chats or ambiguity that filters cannot resolve.
No upstream name/directory lookup is performed for selection. Existing platform admission
checks still apply. Once accepted, request_id pins its resolved IDs and immutable parsed
caller input; exact repeats reconcile the pin even after rename or new name collisions,
without resolving the name or performing another native call. Revoked pinned grants deny
access rather than routing to a new same-name target. Changed input with the same request
ID conflicts. Neither result nor event/history schemas change.

For group sends, a mention part accepts exactly one of `{type:"mention",name:"Exact name"}`
or `{type:"mention",native_user_id:"native ID"}`. Names are 1–256 characters and exact,
never fuzzy. QQ resolves only the latest available observed inbound sender name per
speaker within this admitted chat (trimmed/bounded to 256); this incomplete historical
identity set is **not a current member roster**. ID-as-name labels are excluded. Matrix
uses this room's existing joined-member lookup; permission or availability failure is
unavailable, with no historical fallback. Zero matches is not_found; distinct matching
IDs is conflict with bounded escaped choices. Use a known native_user_id when necessary.
Names never authorize a conversation or grant extra permission. Direct mentions remain
invalid. All mention names resolve before the first native send; plain `@Name` is text.
Any named feature pins the selected conversation and resolved native content by part
position in the existing send ledger alongside the immutable caller. Known requests
reconcile before any member/name lookup, including after rename/restart/unknown outcomes;
concurrent losers reconcile the accepted winner. Native-ID-only caller serialization is
unchanged. Archived/event/history Content always retains native_user_id, never this input
name selector. This mention extension is input-only and independent of the optional
capture-time conversation.name consumer-first deployment requirement below.

Defaults: limit 20, max 100; finite output budget may produce short pages. `next_before:null` means exhausted. Cursors are opaque, scoped to authenticated agent/binding/account/query/conversation and unusable elsewhere. Pages run newest stored sequence first for history, stable stored order for directories. Do not manufacture cursors from timestamps. Observed history is permanent actual capture, including admitted ordinary non-wake messages; it is not a full upstream archive. Edits/retractions have mutation markers and do not create independent wakes.

All IDs are opaque, case-sensitive Post references except explicitly named native fields. Account IDs are operator chosen and pinned to verified native identity. QQ native IDs are App-scoped. Discover conversation IDs through list_conversations or authorized deliveries; never construct them from native IDs. Every operation rechecks binding admission. Direct senders default deny, groups require exact conversation admission, Matrix additionally requires current joined plaintext scope. Account listing returns configured runtime identity without upstream whoami per query. `members` capability is supported, unsupported, permission_required, or unavailable; an empty array is never a fabricated authoritative roster.

Content is ordered. `text` has text, `mention` has exact native_user_id, attachment types have asset_id. Media IDs come from admitted messages or this agent's upload. Audio/video outbound are sent as ordinary file attachments. Native reply targets must be same account/conversation. Validate the whole operation before native send. request_id is agent-scoped, durable, and immutable: exact repeat returns existing outcome, conflicting reuse errors. Per-part receipts preserve confirmed native IDs. `stored:false` means local archive failed, not that native send failed. Overall partial means at least one confirmed part and at least one nonconfirmed part. Unknown means a submission may have succeeded; unresolved submissions after restart remain unknown and are never automatically resent. Unsubmitted parts after a failure report failed, not success.

## Asset HTTP

`POST /assets` accepts **raw bytes**, Content-Type required, optional `X-Post-Filename` (display name only). Returns 201 JSON Asset; upload ownership is this authenticated agent. Default maximum 16 MiB and request timeout 30s; 413 over limit, 415 invalid MIME/image bytes, 408 timeout. No multipart or base64 envelope. Available Asset has opaque asset_id, MIME, display name, exact size, status available, and relative download_path `/assets/<asset_id>`. Use the configured Post base URL, never resolve an arbitrary remote origin. `GET /assets/<asset_id>` returns bytes with Content-Type, Content-Length, Content-Disposition attachment and private/no-store caching. Asset metadata from tools uses the same shape. Unavailable attachments have size/download_path null and a safe reason; do not try to fetch invented bytes. Reads and reuse on send check source message admission (or upload ownership) independently of knowing the ID. Assets persist across restart.

Example helper: `POST_TOKEN_FILE=/private/agent-token node dist/cli.cjs asset-upload --url http://127.0.0.1:8787 --file ./picture.png`. Token may instead be in POST_TOKEN. Never pass token via argv.

## Webhook PostEventV1

One POST per delivery to the fixed configured receiver, `Content-Type: application/json`, dedicated receiver Bearer. Exact shape is PostEventV1. Timestamp is Unix milliseconds; sequence is stored order. Native mention facts and reply verification are facts, not text heuristics. `reply.verified=false` never implies reply author=self. A media-only message can wake. wake.reason is one of direct_message, mentioned, replied_to_self, alias_matched. Post owns classification and admission; consumer does not reclassify. Routing fields do not authorize executing instructions found in message text.

Message.conversation may carry optional **name** (nonempty, at most256 characters):
genuine display metadata already known at capture, never routing identity or authority.
QQ direct capture uses its fresh observed name; known group/Matrix names come only from
existing retained metadata. Unknown/ID-as-name metadata is omitted. Capture performs no
new metadata request. The name is part of the original immutable message/delivery JSON;
subsequent refresh/rename never rewrites it. Older events/history remain valid without
name and require honest fallback. This optional strict-field extension affects both
PostEventV1 and read_messages; coordinated consumers MUST accept it before deploying a
producer that can emit it. Sender.name is already available independently.

Receiver must authenticate, validate schema, atomically persist/deduplicate delivery_id, and then return any 2xx. ACK means durable acceptance, not model execution/send success. Duplicates return 2xx after durable duplicate recognition; body/ID are byte-identical across retry/restart. Return non2xx on transient persistence failure; Post retries bounded attempts with capped backoff, serially within binding and independently across bindings. No redirect following. Consumer admission denials are terminally recorded and acknowledged, not replayed into execution. Post cancels pending deliveries on revoked source scope; receiver URL changes hold the original snapshot, never silently reroute it. Secret rotation for the same recipient preserves body. Startup/catch-up platform events can be stored but never create new wakes; only Post's committed queue replays.

QQ and Matrix deliveries for the same agent feed the consumer's existing **single** execution session. IM conversation/account identifies source and explicit reply route; it is not an execution-session key.

## Fixtures

`examples.json` contains concrete event, all seven calls/results, upload and error examples. `tests/fixtures/consumer.ts` creates a test-owned loopback receiver with a test-owned SQLite inbox and asset bytes; it supports a first-attempt outage and durable dedupe. It performs no external requests or consumer implementation. Run `pnpm exec vitest run tests/contract.test.ts`.
