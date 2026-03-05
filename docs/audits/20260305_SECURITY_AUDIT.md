# Security Audit Report — WebSocket Gateway (ADR-009)

**Project:** Cloudflare Workers Authentication Foundation  
**Date:** March 5, 2026  
**Audit Type:** Feature Security Review (ADR-009 WebSocket Gateway)  
**Auditor:** Claude Opus 4.6  
**Status:** PASSED — 2 FINDINGS (1 INFORMATIONAL, 1 LOW)

---

## Executive Summary

This audit reviews the WebSocket gateway added in the `sockets` branch: the server-side handler (`packages/observability/src/ws/`), the custom WebSocket upgrade utility, HMAC-signed nonce hardening for adaptive PoW challenges, input validation improvements to the HTTP `/ops` router, and the Go CLI WebSocket client (`tools/cli/internal/api/ws.go`). The gateway implements capability-negotiated RPC over WebSocket for operational monitoring, as specified in ADR-009.

Two findings were identified. Neither is exploitable in practice. One is informational (global mutable state in isolate-scoped subscription counter) and one is low severity (subscription LIMIT value interpolated as template literal rather than parameterized). No SQL injection, authentication bypass, authorization escalation, or information disclosure vulnerabilities were found.

**Overall Security Rating:** EXCELLENT

### Scope

Files reviewed:

- `packages/observability/src/ws/handler.ts` — WebSocket connection handler (812 lines)
- `packages/observability/src/ws/upgrade.ts` — custom `upgradeWebSocket` replacing Hono's adapter
- `packages/observability/src/ws/schemas.ts` — Zod inbound message schemas
- `packages/observability/src/ws/index.ts` — barrel export
- `packages/observability/src/router.ts` — `/ops` sub-router (WebSocket route + input hardening changes)
- `packages/observability/src/middleware.ts` — adaptive challenge GET method support + HMAC nonce verification
- `packages/observability/src/process-event.ts` — HMAC-signed nonces (`buildSignedNonce`, `verifySignedNonce`)
- `packages/observability/src/schema.ts` — schema initialization refactor (promise-based)
- `packages/types/src/env.ts` — `WS_ALLOWED_ORIGINS` addition
- `apps/cloudflare-workers/src/app.ts` — unchanged in this diff (no new security surface)
- `tools/cli/internal/api/ws.go` — Go WebSocket client + PoW solver
- `tools/cli/internal/api/ws_types.go` — Go WebSocket message types
- `tools/cli/internal/api/ws_test.go` — `httpToWS` unit tests
- `tools/cli/cmd/plctl/main.go` — TUI tail events feature
- `packages/observability/test/ws/` — 3 test files (handler, upgrade, schemas)

---

## Security Analysis

### 1. SQL Injection

**All queries are parameterized. No injection vectors found.**

WebSocket handler queries follow the same parameterized pattern as the HTTP router:

- `query_events` (`handler.ts:298-346`) — dynamic `WHERE` clauses use hardcoded SQL fragments with `?` placeholders for all user-supplied values (`since`, `event_type`, `user_id`, `ip`, `actor_id`, `limit`, `offset`)
- `query_sessions` (`handler.ts:368-385`) — same pattern: `user_id` and `active` filter via parameterized clauses
- `revoke_session` (`handler.ts:410-444`) — `user_id` and session `id` parameterized in `UPDATE` statements
- `subscribe_events` polling (`handler.ts:537-571`) — high-water mark and type filters are parameterized; wildcard types are converted from `login.*` to `login.%` for `LIKE ?` with the value parameterized
- Credential re-validation (`handler.ts:153-156`) — `agent_credential` lookup uses `WHERE id = ?`

**WS-1 note:** The `LIMIT` in the subscription poll query (`handler.ts:569`) uses template literal interpolation rather than a `?` placeholder: `` LIMIT ${SUBSCRIPTION_POLL_LIMIT} ``. This is safe because `SUBSCRIPTION_POLL_LIMIT` is a module-level constant (`100`), not user input. See findings section.

Input hardening changes to the HTTP router are also correct:

- `GET /ops/events` and `GET /ops/sessions` now use `parseInt(..., 10) || default` for `limit`/`offset`/`user_id` instead of bare `Number()` — prevents `NaN` propagation into queries
- `GET /ops/events` validates `since` with `Date.parse()` before using it — prevents arbitrary string injection into the `created_at >= ?` clause (still parameterized regardless)
- Agent name validation (`POST /ops/agents`) now enforces `^[a-zA-Z0-9_-]+$` regex and 64-char max — prevents path traversal in any downstream use

### 2. Authentication and Authorization

**WebSocket upgrade chain correctly gates access.**

The middleware chain on `GET /ops/ws` (`router.ts:457-499`) enforces five layers before upgrade:

| Step | Check | Failure |
|------|-------|---------|
| 1 | Cloak (`AGENT_PROVISIONING_SECRET` present) | 404 |
| 2 | Rate limit (`rl:ws:connect`, 10/60s, IP-keyed) | 429 |
| 3 | Origin validation | 403 |
| 4 | Adaptive PoW (on `ws.connect_failure` history) | 403 |
| 5 | `requireAgentKey` (SHA-256 hash + DB lookup) | 401 |

**Post-upgrade capability enforcement:** Every gated message type is checked against the `granted` Set before dispatch (`handler.ts:736-753`). `unsubscribe_events` correctly maps to the `subscribe_events` capability (`handler.ts:738-741`). `ping` and re-negotiation attempts are ungated (correct — keepalive must always work).

**Re-negotiation prevention:** A second `capability.request` after negotiation returns `ALREADY_NEGOTIATED` with the `connection_id` (`handler.ts:760-770`). Capabilities are immutable per connection.

**Trust level enforcement:** `revoke_session` requires `write` trust. The `WRITE_CAPABILITIES` set contains only `revoke_session` (`handler.ts:38`). Read agents cannot grant themselves write capabilities — the `allowedCapabilities()` function returns a fixed set based on the DB-stored trust level (`handler.ts:40-45`).

**Credential re-validation:** The heartbeat timer (`handler.ts:259-276`) queries `agent_credential` every 25 seconds. If the key is revoked mid-session, the connection is closed with code `4010` after sending a `credential.revoked` notification. After 3 consecutive DB failures, the connection is closed (`handler.ts:197-212`) — this prevents indefinite fail-open on a sustained DB outage.

### 3. Origin Validation (CSRF Defense)

**Correctly blocks browser-initiated WebSocket connections.**

The origin check (`router.ts:464-478`) only fires when the `Origin` header is present. Non-browser clients (plctl, curl) omit `Origin` and bypass this check — they authenticate via Bearer token downstream. The allowlist is configured via `WS_ALLOWED_ORIGINS` (comma-separated, empty by default), meaning all browser origins are rejected unless explicitly allowed.

This correctly addresses the browser-to-localhost attack vector: a malicious webpage cannot open `ws://localhost:8788/ops/ws` because the browser sends an `Origin` header that won't match the empty allowlist.

### 4. HMAC-Signed Nonces (PoW Hardening)

**Nonces are now server-bound, IP-bound, and time-limited.**

The previous audit noted that PoW nonces were stateless random values — an attacker could pre-compute solutions using self-chosen nonces. This branch replaces random nonces with HMAC-signed composite nonces (`process-event.ts:134-146`):

Format: `randomHex.timestamp.hmac` where HMAC covers `randomHex|timestamp|ipAddress` using `JWT_ACCESS_SECRET`.

Verification (`process-event.ts:154-172`):
1. Splits on `.` — rejects if not exactly 3 parts
2. Recomputes HMAC over `random|timestamp|ipAddress` and compares byte-by-byte with XOR
3. Checks timestamp age against 5-minute TTL

**HMAC comparison is constant-time:** Both `mac` and `expected` are hex-encoded SHA-256 outputs (always 64 characters). The comparison uses `charCodeAt` XOR accumulation (`process-event.ts:165-168`) — no early exit. The length check at line 164 is redundant (both are always 64 chars) but harmless.

**Adaptive challenge now supports GET requests:** `middleware.ts:122-136` extracts `challengeNonce`/`challengeSolution` from query params for GET requests (needed for WebSocket upgrade, which is a GET). POST requests still read from JSON body. Both paths converge on the same nonce verification and SHA-256 PoW check.

### 5. Fail-Open Behavior

**Correct throughout — WebSocket operations never block auth responses.**

- Event emission in the handler uses `.catch()` to swallow errors (`handler.ts:143-144`)
- `processEvent` catches DB insert errors and logs (`process-event.ts:92-94`)
- Subscription polling catches errors and continues the interval (`handler.ts:621-623`)
- Cache invalidation on revocation is wrapped in try/catch (`handler.ts:488-490`)
- Credential re-validation fails open for individual DB errors (up to 3 consecutive), then closes (`handler.ts:191-213`)

### 6. Rate Limiting and DoS Mitigation

**Multiple layers of protection against WebSocket abuse.**

| Layer | Mechanism | Limit |
|-------|-----------|-------|
| Connection rate | `rl:ws:connect` (IP-keyed, requires cache) | 10 connections/60s |
| Adaptive PoW | Triggers on `ws.connect_failure` history | Difficulty escalates with failures |
| Handshake timeout | Server closes if no `capability.request` | 5 seconds |
| Message rate | Per-connection sliding window | 60 messages/60s |
| Subscription cap | Global per-isolate counter | 50 concurrent subscriptions |
| Idle timeout | No client messages within window | 90 seconds |
| Poll result cap | Per-poll row limit | 100 events/poll |

**Message rate limiting** (`handler.ts:667-681`): Sliding window using an array of timestamps. Messages outside the window are evicted before checking the count. Exceeding 60 messages/minute closes the connection with code `4008`.

**Subscription cap** (`handler.ts:522-530`): A module-level `activeSubscriptionCount` prevents unbounded subscription growth. Decremented on unsubscribe and onClose. See WS-2 in findings.

### 7. Information Disclosure

**No sensitive data leaked through WebSocket responses.**

- Event queries use explicit column lists (`handler.ts:344`, `handler.ts:383`, `handler.ts:569`) — `key_hash` column never exposed
- Session queries use explicit column lists (`handler.ts:383`) — excludes `refresh_token_hash`
- Error responses use generic codes (`INTERNAL_ERROR`, `CAPABILITY_NOT_GRANTED`) — no stack traces
- `credential.revoked` messages contain reason codes, not DB error details
- The `connection_id` (nanoid) is a random opaque identifier — no information leakage

### 8. WebSocket Upgrade Utility

**Correct implementation replacing Hono's broken adapter.**

`upgrade.ts` creates a `WebSocketPair`, wraps the server socket in a `WSContext`, wires `onMessage`/`onClose` listeners, calls `server.accept()`, then explicitly calls `onOpen` — addressing the Hono bug where `onOpen` never fires on Cloudflare Workers.

The `Upgrade` header check (`upgrade.ts:32`) returns 426 for non-WebSocket requests. The response includes `webSocket: client` in the init object, which is the Cloudflare Workers API for returning the client side of the pair.

### 9. Schema Validation

**Zod schemas enforce strict input boundaries.**

- `messageId` (`schemas.ts:20`): 1–64 characters — prevents empty IDs and unbounded allocation
- `capability.request` requires non-empty capabilities array
- `query_events` limit: 1–200, offset: >= 0, user_id: positive integer, since: ISO-8601 datetime
- `subscribe_events` type filters: regex `^[a-z_]+(\.\*|\.[a-z_]+)?$` — rejects SQL injection, path traversal, and arbitrary wildcards
- `revoke_session` uses discriminated union on `scope` — `user`/`session` require `target_id`, `all` does not
- Unknown message types are rejected by the discriminated union

The type filter regex deserves specific attention: it allows `login.success`, `login.*`, `rate_limit.reject` but rejects `'; DROP TABLE--`, `login.**`, and `../../../etc/passwd`. This is defense-in-depth alongside parameterized queries.

### 10. CLI Security

**No new attack surface introduced.**

- `ws.go:34` sends the agent key via `Authorization: Bearer` header — same as HTTP routes
- `solvePow` (`ws.go:103-117`): pure computation, no shell execution, respects context cancellation
- `httpToWS` (`ws.go:120-129`): simple string prefix replacement — no URL parsing vulnerabilities
- `keepAlive` goroutine (`main.go:769-786`): sends application-level pings with a 5-second timeout — prevents indefinite blocking
- `closeTail` (`main.go:752-764`): best-effort unsubscribe before close — graceful cleanup
- Tail events buffer capped at 100 entries (`main.go:237-239`) — prevents unbounded memory growth
- `challengeNonce` is passed via query parameter (`ws.go:73`) — the nonce is not a secret (it's HMAC-signed, and the attacker already has it from the challenge response)

### 11. Schema Initialization Refactor

**Promise-based initialization prevents concurrent DDL races.**

`schema.ts` was refactored from a boolean `initialized` flag to a shared `initPromise`. Multiple concurrent callers now share the same initialization promise instead of racing to run DDL statements in parallel. The promise is reset to `null` on error so the next call retries.

New indices (`idx_security_event_type`, `idx_security_event_created`, `idx_security_event_user`, `idx_security_event_ip`, `idx_agent_credential_name`) use `CREATE INDEX IF NOT EXISTS` — idempotent and safe.

---

## Findings

| # | Severity | Category | Finding | Disposition |
|---|----------|----------|---------|-------------|
| WS-1 | Low | Defense in Depth | Subscription poll query uses template literal for LIMIT instead of parameterized placeholder | **Accepted** — value is a module constant, not user input |
| WS-2 | Informational | Resilience | Global mutable `activeSubscriptionCount` is isolate-scoped and not reset on Worker eviction | **Accepted** — Workers isolate lifecycle makes this a known limitation |

### WS-1: Template Literal LIMIT in Subscription Query (Low) — Accepted

The subscription poll query at `handler.ts:569` uses:
```sql
`SELECT ... FROM security_event WHERE ${where} ORDER BY created_at ASC LIMIT ${SUBSCRIPTION_POLL_LIMIT}`
```

`SUBSCRIPTION_POLL_LIMIT` is defined as `const SUBSCRIPTION_POLL_LIMIT = 100` at module scope (`handler.ts:55`). It is never derived from user input. The risk is theoretical: if a future refactor inadvertently made this value dynamic, it could become an injection vector.

**Accepted** because the value is a compile-time constant. Parameterizing it would be a pure defense-in-depth improvement but is not necessary for correctness.

### WS-2: Isolate-Scoped Subscription Counter (Informational)

`activeSubscriptionCount` (`handler.ts:58`) is a module-level variable tracking concurrent subscriptions across all connections in the current isolate. If a Worker isolate is evicted without `onClose` firing (e.g., during a hard crash), the counter is not decremented. On the next isolate spin-up, the counter resets to 0.

This means:
- The 50-subscription cap is per-isolate, not global — multiple isolates can each have 50 subscriptions
- A leaked counter (close without cleanup) reduces capacity until the isolate is recycled

**Accepted** because Workers isolate statefulness makes accurate global counting impossible without Durable Objects. ADR-009 documents this as a deferred enhancement. The `Math.max(0, ...)` guard (`handler.ts:643`, `handler.ts:799`) prevents underflow.

---

## Items Verified as Correct

| Area | Property |
|------|----------|
| Pre-upgrade middleware chain | Rate limit → Origin check → Adaptive PoW → Agent key auth → Upgrade |
| Capability immutability | Re-negotiation returns error without modifying granted set |
| Trust level boundary | Read agents cannot invoke `revoke_session` over WebSocket |
| Credential re-validation | Heartbeat queries DB every 25s; closes on revocation or 3 consecutive failures |
| Idle detection | 90-second timeout requires application-level ping (protocol pings invisible to handler) |
| Message rate limiting | 60/60s sliding window with connection close on breach |
| Subscription lifecycle | Counter incremented on subscribe, decremented on unsubscribe and onClose |
| Backpressure signal | Sent when poll hits 100-event limit; high-water mark still advances |
| HMAC nonce binding | Nonce bound to IP address and 5-minute TTL; HMAC comparison is constant-time |
| Origin validation | Rejects browser origins by default; non-browser clients bypass (no Origin header) |
| Event column safety | All WebSocket queries use explicit column lists (no `SELECT *`) |
| Cache invalidation | `revoke_session` handler invalidates `session:` and `user_sessions:` cache keys |
| CLI keepalive | 60-second ping interval stays within 90-second server timeout |
| CLI buffer cap | Tail event buffer capped at 100 entries |
| Core auth unchanged | No modifications to `account-service`, `session-service`, `require-auth`, or any file in `packages/core/src/auth/` |

---

## Comparison with Previous Audits

The WebSocket gateway is additive to the `/ops` surface established in ADR-008:

- Password hashing, JWT verification, session management — unchanged, no regressions
- `timingSafeEqual` implementation — unchanged since the OBS-4 fix (length-padded double-HMAC)
- `requireAgentKey` — unchanged; reused as the final pre-upgrade middleware
- Fail-open error handling — consistent with `createAuthSystem`, rate limiter, and observability middleware

New security hardening applied to existing code:

- **HMAC-signed nonces** replace stateless random nonces for PoW challenges — nonces are now IP-bound, time-limited, and tamper-resistant
- **Input hardening** on HTTP `/ops` routes — `parseInt` with NaN guards, `Date.parse` validation for `since`, agent name regex
- **Schema initialization** refactored to promise-based deduplication — prevents DDL races

---

## Verification

```bash
bun run build        # Clean build
bun run typecheck    # No type errors
bun run lint         # No lint violations (130 files checked)
bun run test:unit    # 573 tests passing (28 test files)
```

### Unit tests (573 passing, 28 files)

Relevant suites to this audit:

| Suite | Tests | Security properties covered |
|-------|-------|----------------------------|
| `ws/handler.test.ts` | 60+ | Capability negotiation, trust level enforcement, capability gating, re-negotiation rejection, handshake timeout, message rate limiting, subscription lifecycle, subscription cap, credential re-validation, idle detection, query parameterization, revocation + cache invalidation, event emission, close cleanup |
| `ws/upgrade.test.ts` | 9 | Upgrade header check, 426 rejection, server.accept() call, onOpen invocation, event listener wiring, WSContext delegation |
| `ws/schemas.test.ts` | 30+ | Input validation boundaries for all 7 message types, SQL injection rejection, wildcard pattern validation, empty/missing field rejection |
| `middleware.test.ts` | Tests | Adaptive challenge GET method support, HMAC nonce verification, signed nonce rejection |
| `router.test.ts` | Tests | Origin validation, WebSocket rate limiting, cloaking, agent name regex, input hardening |
| `process-event.test.ts` | Tests | Signed nonce build/verify, HMAC correctness, TTL expiry |

All checks passed at time of audit.
