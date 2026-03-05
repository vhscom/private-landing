# ADR-009: Operational WebSocket Gateway

- **Status:** Accepted
- **Date:** 2026-03-02
- **Decision-makers:** @vhscom

## Context and Problem Statement

[ADR-008](008-adaptive-challenges-ops.md) established the `/ops` HTTP surface for querying security events, managing sessions, and provisioning agent credentials. The surface works, but every interaction opens a connection, authenticates via SHA-256 key hash + DB lookup, executes a single query, and closes.

A monitoring agent polling `GET /ops/events` once per second performs 60 SHA-256 hashes and 60 `agent_credential` lookups per minute — identical work repeated for every request. The key never changes; the trust level never changes; the agent identity never changes. This is the dominant cost of the current design.

Two secondary limitations compound the overhead problem:

1. **No live visibility.** During an active incident, an operator tailing events via `plctl` is polling at human-tolerable intervals. Events accumulate between polls. The operator sees a stale snapshot, not the unfolding attack.

2. **No capability scoping beyond trust level.** An agent with `read` trust receives all data on every request. There is no mechanism to express "I only need `login.*` events" or "subscribe to session changes for user 42." The server performs full queries regardless of what the client actually needs.

How should we reduce authentication overhead for persistent operational connections while adding live event visibility and per-connection capability scoping?

## Decision Drivers

* **Authenticate once** — agent identity and trust level are established at the HTTP upgrade; subsequent messages inherit that context without re-authentication
* **Capability-scoped** — clients declare what they need; the server grants or denies each capability against the agent's trust level and pushes only matching data
* **Anti-hijack** — browser-initiated WebSocket connections to localhost are a known attack vector; the gateway must reject browser origins by default
* **Removable** — the gateway lives inside `packages/observability`; removing the package removes the gateway with no core changes
* **No new infrastructure** — no Durable Objects, no external pub/sub; the gateway operates within the existing Workers + Turso stack
* **Fail-open** — gateway failures (DB errors, event emission failures) must never block authentication or corrupt existing `/ops` HTTP endpoints
* **Observable** — every gateway lifecycle event (connect, disconnect, capability grant/deny, unauthorized invocation) emits a structured `security_event`

## Decision Outcome

Add a `GET /ops/ws` WebSocket endpoint to the existing `/ops` sub-router. No additional packages are required — `hono@^4.11.5` and `@cloudflare/workers-types@^4.20260124.0` (both already installed) provide full WebSocket support.

The connection lifecycle has three stages: HTTP upgrade (authentication), capability negotiation (authorization), and active messaging (operations).

### HTTP Upgrade

The WebSocket handshake begins as a standard HTTP request. All security checks execute before the protocol switch — once upgraded, the server cannot return HTTP status codes.

The pre-upgrade middleware chain reuses existing infrastructure:

| Step | Middleware | Failure |
|---|---|---|
| 1 | Cloak check (`AGENT_PROVISIONING_SECRET` present?) | `404` — indistinguishable from non-existent route |
| 2 | Rate limit (`rl:ws:connect`, IP-keyed) | `429` with `Retry-After` |
| 3 | Origin validation | `403` — browser origins rejected |
| 4 | Adaptive PoW (if recent `ws.connect_failure` events from IP) | `403` with challenge |
| 5 | `requireAgentKey` (SHA-256 hash, DB lookup) | `401` — emits `agent.auth_failure` |
| 6 | `upgradeWebSocket()` | `101 Switching Protocols` |

Step 2 uses `createRateLimiter`, which degrades to a no-op when the cache layer is absent ([ADR-003](003-cache-layer-valkey.md), [ADR-006](006-rate-limiting.md)). In the default no-cache deployment, the remaining defenses are: origin validation (step 3), adaptive PoW (step 4, which queries `security_event` in SQL — no cache required), and agent key authentication (step 5, where 256-bit keys make brute-force infeasible).

All pre-upgrade failures emit a `ws.connect_failure` event with the failure reason.

**Origin validation:** Browsers send an `Origin` header on WebSocket upgrade requests. Non-browser clients (plctl, curl, AI agents) do not. The gateway rejects connections that include an `Origin` header unless it matches an explicit allowlist (`WS_ALLOWED_ORIGINS`, comma-separated, empty by default). This blocks the primary browser-to-localhost attack vector: a malicious page opening `ws://localhost:8788/ops/ws` to hijack agent credentials.

### Capability Negotiation

After upgrade, the server waits for a `capability.request` message. If it does not arrive within 5 seconds, the server closes with code `4001` (handshake timeout). The client sends the list of capabilities it wants:

```json
{
  "type": "capability.request",
  "capabilities": ["query_events", "subscribe_events", "revoke_session"]
}
```

The capabilities array accepts arbitrary strings — the schema does not reject unknown capability names at parse time. The server validates each requested capability against the known set and the agent's trust level, then responds with what was granted and what was denied. Unknown capabilities are denied with reason `"unknown capability"`; trust-insufficient capabilities are denied with `"requires write trust level"`:

```json
{
  "type": "capability.granted",
  "connection_id": "V1StGXR8_Z5jdHi6B-myT",
  "agent": "monitor-bot",
  "granted": ["query_events", "subscribe_events"],
  "denied": [{ "capability": "revoke_session", "reason": "requires write trust level" }]
}
```

The `connection_id` (nanoid) uniquely identifies this WebSocket session across all `security_event` records emitted during the connection's lifetime. Capabilities are immutable — to change them, the client must disconnect and reconnect. If a client sends a second `capability.request`, the server responds with `ALREADY_NEGOTIATED` and includes the `connection_id` so the client can recover it without reconnecting.

A single `ws.connect` event is emitted after negotiation, containing the `connectionId`, agent name, and the granted/denied capability arrays.

#### Capability Model

| Capability | Trust Level | Direction | Description |
|---|---|---|---|
| `query_events` | read | request/response | One-shot event query (mirrors `GET /ops/events`); pass `aggregate: true` for counts by type |
| `query_sessions` | read | request/response | One-shot session list (mirrors `GET /ops/sessions`) |
| `subscribe_events` | read | server push | Live event stream with optional type filters |
| `revoke_session` | write | request/response | Revoke by scope: `user`, `session`, or `all` |

`revoke_session` supports three scopes: `user` (by user ID), `session` (by session ID), and `all` (every active session). This mirrors the HTTP `POST /ops/sessions/revoke` design — any agent with `write` trust can revoke at any scope. The capability boundary is `write` trust, not the scope value.

Agent management (`POST /ops/agents`, `DELETE /ops/agents/:name`) remains HTTP-only. Provisioning uses the infrastructure secret, not agent keys — a different auth model that does not map to the WebSocket capability pattern.

### Message Format

All messages after capability negotiation follow a typed envelope with a `type` discriminator. Request/response messages carry a client-generated `id` (1–64 characters) echoed in the response for correlation. The `payload` field defaults to `{}` when omitted for `query_events`, `query_sessions`, and `subscribe_events` — all payload fields within these messages are optional. Inbound messages are validated against a Zod discriminated union schema — messages for capabilities that were not granted receive a `CAPABILITY_NOT_GRANTED` error and emit a `ws.unauthorized` event.

Responses echo the request's `type` and `id` with `ok: true` on success or `ok: false` with an error object on failure:

```json
{ "type": "query_events", "id": "q1", "ok": true, "payload": { "events": [...], "count": 3 } }
{ "type": "revoke_session", "id": "r1", "ok": false, "error": { "code": "CAPABILITY_NOT_GRANTED", "message": "..." } }
```

Error codes: `CAPABILITY_NOT_GRANTED`, `INVALID_PAYLOAD`, `INTERNAL_ERROR`, `SUBSCRIPTION_ACTIVE`, `SUBSCRIPTION_LIMIT`, `ALREADY_NEGOTIATED`.

`ping` messages require no capability and the `id` field is optional — keepalive is always permitted. When `id` is present, the `pong` response echoes it; when absent, the `pong` omits `id`. One subscription at a time — sending `subscribe_events` while a subscription is active returns `SUBSCRIPTION_ACTIVE`; send `unsubscribe_events` first.

**Cache invalidation on revocation:** The `revoke_session` handler performs the same conditional cache cleanup as the HTTP `POST /ops/sessions/revoke` route ([ADR-003](003-cache-layer-valkey.md)): when `createCacheClient` is present, the handler deletes affected `session:{id}` and `user_sessions:{uid}` cache keys after expiring the SQL rows. For `scope: "all"`, affected user IDs are pre-collected before the bulk update. Cache cleanup is best-effort; failures are caught and logged.

### Lifecycle Messages

The server sends three lifecycle messages that are not part of the request/response pattern. Clients should handle these but do not need to respond.

#### `heartbeat`

Sent every 25 seconds after credential re-validation succeeds.

```json
{
  "type": "heartbeat",
  "ts": 1709510400000,
  "next_check_ms": 25000,
  "ping_timeout_ms": 90000,
  "capabilities": ["query_events", "subscribe_events"]
}
```

`next_check_ms` tells the client when the next validation will occur. `ping_timeout_ms` is the idle budget before the server closes the connection. `capabilities` echoes the granted list so clients can confirm state without tracking it locally.

Each heartbeat cycle performs three steps in order: **idle detection** (closes with `4011` if no client message within 90 seconds), **credential re-validation** (queries `agent_credential` — closes with `4010` if revoked, fails open on DB error), and **heartbeat send**. If idle or credential checks fail, no heartbeat is sent — the connection closes immediately. Protocol-level WebSocket pings are invisible to `onMessage` and do not reset the idle timer; clients must send application-level `ping` messages to stay alive.

The heartbeat timer is cleared on close. The `onClose` handler emits a single `ws.disconnect` event for all disconnections.

#### `credential.revoked`

Sent immediately before a `4010` close when the agent credential is found revoked during the heartbeat.

```json
{
  "type": "credential.revoked",
  "reason": "key_revoked",
  "guidance": "Re-authenticate with a new agent key"
}
```

`reason` is `"key_revoked"`, `"credential_not_found"`, or `"credential_check_unavailable"`. After 3 consecutive credential check failures the server closes the connection rather than failing open indefinitely.

#### `subscription.backpressure`

Sent after a subscription poll when the result set hits the per-poll limit (100 events).

```json
{
  "type": "subscription.backpressure",
  "count": 100,
  "limit": 100
}
```

Signals that the client is falling behind and events may be delayed. The high-water mark still advances, so no events are lost — they arrive on the next poll.

### Close Codes

| Code | Name | Meaning |
|---|---|---|
| `1000` | NORMAL | Clean shutdown initiated by either side |
| `4001` | HANDSHAKE_TIMEOUT | Client did not send `capability.request` within 5 seconds |
| `4002` | PROTOCOL_ERROR | Malformed JSON or unknown message type |
| `4008` | RATE_LIMITED | Inbound message rate exceeded per-connection limit |
| `4009` | SERVER_SHUTDOWN | Server is shutting down (e.g. Worker eviction) |
| `4010` | CREDENTIAL_REVOKED | Agent credential revoked or expired mid-session |
| `4011` | PING_TIMEOUT | No client messages received within 90 seconds |

Codes 4003–4007 are reserved for future use. All close events emit `ws.disconnect` with the close code and `connectionId`.

### Event Types

The gateway adds these event types to the catalog established in [ADR-008](008-adaptive-challenges-ops.md):

| Event Type | Source | Detail |
|---|---|---|
| `ws.connect` | Capability negotiation | `{ connectionId, agent }` |
| `capability.granted` | Capability negotiation | `{ connectionId, capability }` |
| `capability.denied` | Capability negotiation | `{ connectionId, capability, reason }` |
| `ws.connect_failure` | Pre-upgrade middleware | `{ reason, origin? }` |
| `ws.disconnect` | Close handler | `{ connectionId, code, reason }` |
| `ws.unauthorized` | Message dispatch | `{ connectionId, type }` |
| `ws.credential_revoked` | Heartbeat credential check | `{ connectionId, reason }` |
| `session.ops_revoke` | Revoke handlers (HTTP and WS) | `{ connectionId?, scope, id?, revoked }` |

### Subscription Implementation

Cloudflare Workers without Durable Objects are stateless — each isolate handles connections independently with no cross-isolate broadcast. For v1, subscriptions use server-side polling over WebSocket:

1. Client sends `subscribe_events` with optional type filters (exact or wildcard like `login.*`).
2. Server acknowledges with `{ interval_ms: 5000 }`.
3. Server polls `security_event` at the declared interval, filtering by the subscription's type patterns and a high-water-mark timestamp.
4. New events are pushed in a normalized envelope — the DB row's `id` and `type` columns are renamed to `event_id` and `event_type` to avoid collision with the protocol's `type` discriminator and correlation `id`. The `detail` column (stored as a JSON string) is parsed into an object:
   ```json
   {
     "type": "event",
     "payload": {
       "event_id": 1234,
       "event_type": "login.failure",
       "ip_address": "203.0.113.1",
       "user_id": null,
       "detail": { "email": "*@example.com" },
       "created_at": "2026-03-04T12:00:00.000Z",
       "actor_id": "app:private-landing"
     }
   }
   ```
5. Client sends `unsubscribe_events` or disconnects.

The `interval_ms` field makes the polling cadence explicit — no false real-time pretense. Subscriptions query SQL directly — they do not depend on the cache layer, making live event tailing available in the default no-cache deployment.

### plctl Integration

A "Tail events (live)" menu item in the existing plctl TUI opens a WebSocket connection to `/ops/ws`, requests the `subscribe_events` capability, and streams events until the user presses `esc`. A concurrent keepalive goroutine sends `ping` messages every 60 seconds during tail sessions, well within the 90-second ping timeout. The Go client uses `github.com/coder/websocket` which supports one concurrent reader and one concurrent writer safely.

## Consequences

### Positive

- Agents authenticate once per connection instead of once per request — eliminates redundant SHA-256 hashes and DB lookups during sustained monitoring
- Capability model scopes what each connection can do — a `read`-trust agent cannot revoke sessions even if it knows the message format
- Origin validation blocks browser-to-localhost attacks by default with zero configuration
- Every gateway lifecycle event emits a structured `security_event` — connect, disconnect, and unauthorized invocations are all queryable
- No Durable Objects required — operates within the existing Workers + Turso stack
- Protocol is JSON-over-WebSocket — debuggable with `websocat`, browser devtools, or `wscat`
- Inherits the same cloaking behavior as HTTP `/ops` — invisible without `AGENT_PROVISIONING_SECRET`
- Subscription `interval_ms` makes the polling cadence explicit to the client

### Negative

- Without Durable Objects, `subscribe_events` is polling (every `interval_ms`) not true push — events may be delayed up to one poll interval; cross-isolate events appear on the next poll, not immediately
- The 5-second capability negotiation deadline is aggressive for high-latency or cold-start scenarios (mitigated by the standard WebSocket reconnect-and-retry pattern)
- Origin validation is allow-by-absence — non-browser clients that set `Origin` (some HTTP libraries do) will be rejected unless explicitly allowlisted
- Credential re-validation adds one DB query per connection every 25 seconds — negligible at expected connection counts but scales linearly
- Idle detection requires clients to send application-level pings — protocol-level WebSocket pings are invisible to `onMessage`
- In `wrangler dev`, every WebSocket close produces a spurious `Uncaught Error: The Workers runtime canceled this request` because the workerd hang detector does not wait for fire-and-forget event emissions after the socket closes; events are still written to the database despite the error

## Alternatives Considered

### Improved HTTP Polling

Add `ETag` / `If-None-Match` or `Last-Event-ID` to `GET /ops/events` for efficient conditional polling.

- Good, because it requires no protocol change — existing HTTP surface, existing auth
- Good, because it reduces redundant data transfer (304 when no new events)
- Bad, because it does not reduce authentication overhead (still one SHA-256 hash + DB lookup per request)
- Bad, because it does not enable capability scoping — every poll returns all data matching the query
- Rejected because it addresses data efficiency but not the authentication overhead or capability scoping gaps

### Server-Sent Events (SSE)

Use `text/event-stream` from a `GET /ops/events/stream` endpoint for server push.

- Good, because it is simpler than WebSocket — no upgrade negotiation, standard HTTP
- Good, because SSE supports `Last-Event-ID` for reconnection
- Bad, because SSE is unidirectional (server to client) — write operations (revoke) still require separate HTTP requests
- Bad, because SSE on Cloudflare Workers has the same isolate-statefulness constraint as WebSocket — no cross-isolate broadcast without Durable Objects
- Rejected because unidirectional push does not support the request/response capability pattern (query, revoke) that makes the gateway a unified operational surface

### Durable Objects for True Server-Push

Use a Durable Object to hold WebSocket connections and broadcast events in real time.

- Good, because it enables true server-push — `processEvent` notifies the DO, which fans out to all connected subscribers
- Good, because a single DO instance provides cross-isolate coordination
- Bad, because it adds a `[[durable_objects]]` binding and migration to `wrangler.toml` — a meaningful infrastructure change
- Bad, because Durable Objects are a Cloudflare-specific feature — reduces portability of the reference implementation
- Bad, because removing the gateway would require also removing the DO binding — violates the "delete one package" removability contract
- Rejected for v1 because the polling-over-WebSocket approach demonstrates the same capability model and security properties without new infrastructure. Documented as a future enhancement.

## Non-Goals

- **Cross-isolate broadcast** — true real-time fan-out is deferred to the Durable Object path
- **Binary WebSocket frames** — all messages are JSON text frames; binary protocols add parsing complexity without meaningful benefit for the event volumes of an auth service
- **WebSocket compression** (`permessage-deflate`) — adds implementation complexity; event payloads are small
- **Agent management over WebSocket** — provisioning and revocation use a different auth model (infrastructure secret) and remain HTTP-only
- **Browser client support** — the gateway serves non-browser agents by default; browser access requires explicit `WS_ALLOWED_ORIGINS` configuration

## Deferred

- **Durable Object fan-out** — when true server-push is warranted, add a `ConnectionManager` DO that holds WebSocket connections and receives event notifications from `processEvent`. This requires `[[durable_objects]]` and `[[migrations]]` in `wrangler.toml` and a DO class export from `app.ts`.
- **Connection limit per agent** — preventing a single agent key from opening excessive concurrent connections. Deferred because Workers isolate statefulness makes accurate counting difficult without Durable Objects.

## Implementation Notes

- **WebSocket upgrade:** Custom `upgradeWebSocket` in `packages/observability/src/ws/upgrade.ts` — drop-in replacement for Hono's `hono/cloudflare-workers` adapter. The stock Hono adapter never fires `onOpen` ([honojs/hono#3448](https://github.com/honojs/hono/issues/3448), [honojs/hono#4095](https://github.com/honojs/hono/issues/4095)), so the handler has no `ws` reference until the first message arrives — making handshake deadlines unenforceable for silent clients. The custom helper wraps the native `WebSocketPair` API and calls `onOpen` explicitly after `server.accept()`. Testable independently (see `test/ws/upgrade.test.ts`).
- **Route location:** Added to `createOpsRouter()` in `packages/observability/src/router.ts` alongside existing HTTP routes. Inherits the cloaking middleware.
- **Schemas:** Inbound and outbound Zod schemas live in `packages/observability/src/ws/schemas.ts` — internal to the plugin, not exported to `packages/schemas`.
- **Connection state:** A per-connection `Set<Capability>` of granted capabilities, the `connection_id`, agent identity, and subscription state (high-water timestamp, type filters, interval handle).
- **Rate limiting:** Connections exceeding 60 messages per 60-second sliding window are closed with code `4008`. A global cap of 50 concurrent subscriptions per isolate prevents sustained DB polling abuse.
- **plctl:** New menu item "Tail events (live)" in `tools/cli/cmd/plctl/main.go`. New `internal/api/ws.go` for the WebSocket client using `github.com/coder/websocket`.
- **Environment:** Optional `WS_ALLOWED_ORIGINS` (comma-separated) in Worker env for browser origin allowlist.
- **Testing:** WebSocket handler tests live in `packages/observability/test/ws/` using plain vitest with mocked `WSContext` and `createDbClient`. Capability negotiation, unauthorized invocation, origin rejection, and close codes each have dedicated test cases.

## References

- [ADR-008: Adaptive Challenges and Operational Surface](008-adaptive-challenges-ops.md) — establishes `/ops` surface, agent credentials, event catalog
- [ADR-007: Session Dual-Write](007-session-dual-write.md) — ensures SQL session visibility for `/ops/sessions` queries
- [ADR-006: Rate Limiting](006-rate-limiting.md) — reused for `rl:ws:connect` rate limit bucket
- [ADR-005: URL Reorganization](005-url-reorganization.md) — semantic route grouping for `/ops/*`
- [ADR-003: Cache Layer with Valkey](003-cache-layer-valkey.md) — cache invalidation on session revocation via WebSocket
- [RFC 6455: The WebSocket Protocol](https://datatracker.ietf.org/doc/html/rfc6455) — close codes 4000–4999 for private use
- [Hono WebSocket Helper](https://hono.dev/docs/helpers/websocket) — `upgradeWebSocket` API
- [Cloudflare Workers WebSocket](https://developers.cloudflare.com/workers/runtime-apis/websockets/) — native `WebSocketPair` API
