# Security Audit Report — Control Plugin (ADR-010)

**Project:** Cloudflare Workers Authentication Foundation  
**Date:** March 9, 2026  
**Audit Type:** Feature Security Review (ADR-010 Control Plugin)  
**Auditor:** Claude Opus 4.6  
**Status:** PASSED — 4 FINDINGS (4 LOW)

---

## Executive Summary

This audit reviews the control plugin added in the `ctl2` branch: a transparent WebSocket proxy and HTTP reverse proxy that gives the authenticated operator (uid=1) access to an external gateway's control surface through Private Landing. The plugin layers on top of `packages/observability` and mounts routes on its `/ops` sub-router.

Four low-severity findings were identified (path rewrite edge case, token injection on all connect-shaped messages, isolate-scoped connection limit, no origin validation on control WebSocket path). All have mitigating factors that reduce practical exploitability. Five security hardening measures are present in the implementation: sensitive header stripping on the HTTP proxy, binary frame rejection, pending message buffer cap, GATEWAY_URL SSRF validation, and fail-closed session re-validation.

**Overall Security Rating:** EXCELLENT

### Scope

Files reviewed:

- `packages/control/src/index.ts` — plugin entry, route handlers, cloaked auth, WebSocket multiplexer (146 lines)
- `packages/control/src/bridge/handler.ts` — transparent WebSocket proxy handler (419 lines)
- `packages/control/src/bridge/types.ts` — constants, close codes, connection state (83 lines)
- `packages/control/src/proxy.ts` — HTTP reverse proxy for static assets (56 lines)
- `packages/control/src/middleware/ip-allowlist.ts` — optional IP restriction (46 lines)
- `packages/control/src/middleware/user-one-guard.ts` — uid=1 authorization (22 lines)
- `packages/control/src/types.ts` — environment bindings, SSRF validation (52 lines)
- `packages/control/test/handler.test.ts` — WebSocket handler unit tests (1049 lines)
- `packages/control/test/proxy.test.ts` — HTTP proxy unit tests
- `packages/control/test/ip-allowlist.test.ts` — IP allowlist unit tests
- `packages/control/test/user-one-guard.test.ts` — user-one-guard unit tests
- `packages/control/test/gateway-url.test.ts` — SSRF validation unit tests
- `apps/cloudflare-workers/src/app.ts` — plugin wiring and registration order
- `apps/cloudflare-workers/test/integration/plugins/control/access.test.ts` — integration tests

---

## Security Analysis

### 1. Authentication and Authorization

**Cloaked auth correctly returns 404 on all failure paths.**

The control plugin enforces four layers of defense before granting access to any route:

| Step | Mechanism | Failure mode |
|------|-----------|--------------|
| 1 | `cloakedAuth` — JWT via `requireAuth` | 404 (not 401) |
| 2 | `userOneGuard` — hardcoded uid=1 | 404 (not 403) |
| 3 | `ipAllowlist` — optional `CONTROL_ALLOWED_IPS` | 404 |
| 4 | Gateway config check — `GATEWAY_URL` + `GATEWAY_TOKEN` | 404 |

Auth failures are indistinguishable from non-existent routes. The cloaked auth pattern (`index.ts:48-54`) intercepts the `requireAuth` middleware's `next()` callback to detect success without calling the downstream handler on failure.

**`/ops/ws` multiplexer correctly dispatches by auth type:**

- Bearer header → falls through to agent handler via `next()` (`index.ts:113-115`)
- No Bearer + no gateway config → 404 (`index.ts:122-124`) — prevents info leak where agent handler would return 401
- No Bearer + gateway config → cookie auth → uid=1 guard → IP allowlist → proxy upgrade (`index.ts:127-144`)

Registration order in `app.ts` is critical: `controlPlugin()` runs before `mountAgentWs()`, so the control plugin's `/ws` handler intercepts cookie-based requests before the agent handler sees them. Bearer requests pass through unchanged.

### 2. Token Isolation

**`GATEWAY_TOKEN` never reaches the client. Confirmed.**

Token injection (`handler.ts:211-227`) operates only in the client-to-backend direction. The `injectToken()` function replaces `params.auth` on outbound `{ type: "req", method: "connect" }` frames. Backend-to-client messages are relayed via `sendToClient(ws, String(ev.data))` (`handler.ts:320-322`) — the token is never included in responses.

**Header stripping on HTTP proxy** (`proxy.ts:34-36`): The reverse proxy constructs a new `Headers` from the incoming request and deletes `Cookie` and `Authorization` before forwarding to the gateway. This prevents JWT access/refresh tokens from leaking to the upstream gateway.

### 3. WebSocket Security

**Session-bound heartbeat re-validates every 25 seconds.**

The heartbeat (`handler.ts:193-203`) queries the `session` table to verify the operator's PL session is still valid. If the session is revoked or expired, the connection is closed with code `4010` (SESSION_REVOKED). This closes the revocation window from the 15-minute access token TTL to 25 seconds.

**Fail-closed on DB errors** (`handler.ts:181-191`): If the session check query fails, the connection is closed rather than kept open. This prevents indefinite access when the database is unreachable.

**Rate limiting and buffer controls:**

| Control | Limit | Enforcement |
|---------|-------|-------------|
| Message rate | 10 messages/second (fixed window) | Close code 4029 |
| Message size | 1 MB per frame | Close code 1009 |
| Pending buffer | 20 messages during backend connect | Close code 4029 |
| Binary frames | Rejected (JSON-only protocol) | Close code 1003 |
| Idle timeout | 30 minutes | Close code 4408 |
| Concurrent connections | 1 per user (supersedes old) | Close code 4012 |
| Backend connect timeout | 5 seconds | Close code 4502 |

### 4. HTTP Reverse Proxy

**Generic error responses prevent information disclosure.**

Gateway errors (5xx, network failures) return `{ "error": "Bad Gateway" }` with status 502 (`proxy.ts:45-47`, `proxy.ts:53-54`). No gateway error details, stack traces, or internal URLs are forwarded to the client.

**Path rewriting** (`proxy.ts:32`): `target.pathname.replace("/ops/control", "")` strips the mount prefix. The `URL` constructor normalizes the path, preventing directory traversal. See CTL-1.

### 5. SSRF Validation

**`GATEWAY_URL` validated against SSRF targets before any outbound request.**

`isSafeGatewayUrl` (`types.ts:29-52`) enforces:

| Check | Blocked targets |
|-------|-----------------|
| Protocol | Non-HTTP/HTTPS schemes (ftp, file, etc.) |
| Link-local | `169.254.*`, `fe80:*` |
| Cloud metadata | `metadata.google.*`, `metadata.internal` |
| Loopback (production) | `localhost`, `127.0.0.1`, `::1` |
| Invalid URLs | Malformed strings, empty values |

Both `proxyToGateway` (`proxy.ts:18-25`) and `connectBackend` (`handler.ts:265`) call `isSafeGatewayUrl` before making any outbound connection. Localhost is permitted in non-production environments for local development.

### 6. Middleware Implementation

**`userOneGuard`** (`user-one-guard.ts:13-22`): Reads `jwtPayload` from context, checks `uid === 1`, returns `ctx.notFound()` on failure. Simple and correct — no timing side channels (the JWT is already verified by `requireAuth`).

**`ipAllowlist`** (`ip-allowlist.ts:14-46`): Parses `CONTROL_ALLOWED_IPS` from the environment on each request. When the env var is absent or empty, the middleware is a no-op (passes through). When set, the client IP is checked against the comma-separated list. Failure returns `ctx.notFound()`. Handles `getClientIp` throwing gracefully — defaults to `"unknown"` which won't match any allowlist entry.

### 7. Fail-Open Behavior

**Consistent with the rest of the codebase.**

- `obsEmitEvent` calls are fire-and-forget (`index.ts:99-102`) — event emission failures do not block proxy responses
- Backend WebSocket errors close the client connection cleanly (`handler.ts:312-318`)
- Backend connect timeout (5 seconds) prevents indefinite connection hang (`handler.ts:277-280`)
- Session check errors close the connection (fail-closed, not fail-open) — this is correct for a security check

---

## Findings

| # | Severity | Category | Finding | Disposition |
|---|----------|----------|---------|-------------|
| CTL-1 | Low | Defense in Depth | `String.replace` only strips first `/ops/control` occurrence in path | **Accepted** |
| CTL-2 | Low | Defense in Depth | Token injection fires on all connect-shaped messages, not just initial handshake | **Accepted** |
| CTL-3 | Low | Resilience | `activeConnections` map is isolate-scoped; concurrent connection limit is per-isolate | **Accepted** |
| CTL-4 | Low | CSRF | No `Origin` validation on control WebSocket path | **Accepted** |

### CTL-1: Path Rewrite Edge Case (Low) — Accepted

`proxy.ts:32` uses `String.replace("/ops/control", "")` which only replaces the first occurrence. A crafted path like `/ops/control/ops/control/secret` would produce `/ops/control/secret` after rewrite.

**Mitigating factors:**
- The `URL` constructor normalizes paths — directory traversal via `..` is handled
- The gateway must serve content at the resulting path for this to matter
- The route is behind uid=1 auth — the operator is attacking their own gateway

**Accepted** because exploitation requires the operator to craft malicious paths against their own infrastructure.

### CTL-2: Token Injection Scope (Low) — Accepted

`injectToken()` (`handler.ts:211-227`) replaces `params.auth` on any message matching `{ type: "req", method: "connect" }`, not just the initial handshake. The client can trigger token injection at will by sending connect-shaped messages.

**Mitigating factors:**
- The token is injected server-side and never returned to the client — the client cannot extract `GATEWAY_TOKEN`
- The client already has access to the proxied gateway session — re-injecting the token does not grant additional privilege
- The gateway validates connect requests independently

**Accepted** because the client cannot observe or exfiltrate the injected token.

### CTL-3: Isolate-Scoped Connection Limit (Low) — Accepted

`activeConnections` (`handler.ts:31-34`) is a module-level `Map`. On Cloudflare Workers, each request may land on a different isolate. The one-connection-per-user limit only applies within a single isolate — an operator could theoretically have multiple concurrent connections routed to different isolates.

**Mitigating factors:**
- The uid=1 restriction limits this to a single user — the only "attacker" is the operator themselves
- The limit is defense-in-depth (resource conservation), not a security boundary
- Accurate global state on Workers requires Durable Objects, which is out of scope
- The previous audit (ADR-009) accepted an identical isolate-scoping limitation (WS-2) as Informational

**Accepted** as a known platform limitation. ADR-010 documents the concurrent connection limit as best-effort.

### CTL-4: No Origin Validation on Control WebSocket Path (Low) — Accepted

The agent WebSocket path (`/ops/ws` for Bearer connections) validates the `Origin` header against `WS_ALLOWED_ORIGINS`. The control proxy path does not — it forwards the origin to the backend gateway instead (`handler.ts:239-258`).

**Mitigating factors:**
- Cookie auth uses `SameSite=Strict` — cross-origin requests from a malicious page will not include the operator's cookies
- The uid=1 guard and optional IP allowlist provide additional layers
- The gateway performs its own origin validation on the forwarded header

**Accepted** because `SameSite=Strict` cookies prevent cross-origin WebSocket CSRF. The forwarded origin allows the gateway to enforce its own origin policy.

---

## Items Verified as Correct

| Area | Property |
|------|----------|
| Cloaked auth | All auth/authz failures return 404 — no 401 or 403 responses from control routes |
| `/ws` multiplexer | Non-Bearer requests without gateway config return 404 (not 401 via agent handler) |
| Token isolation | `GATEWAY_TOKEN` injected server-side only; never included in client-bound messages |
| Header stripping | `Cookie`/`Authorization` removed before upstream fetch |
| Session binding | Heartbeat re-validates PL session every 25s; closes on revocation or DB error |
| Fail-closed | DB errors during session check close the connection (not fail-open) |
| Rate limiting | 10 msg/s fixed window with connection close on breach |
| Buffer cap | 20 pending messages during backend connect |
| Frame validation | Binary frames rejected with close code 1003 |
| Message size | 1 MB limit enforced before any processing |
| Idle timeout | 30-minute inactivity closes connection |
| Concurrent limit | New connection supersedes old for same uid (per-isolate) |
| Error cloaking | Generic 502 for gateway errors; no detail forwarded |
| SSRF validation | `GATEWAY_URL` validated against link-local, metadata endpoints, non-HTTP schemes; localhost blocked in production |
| Plugin independence | Control cloaks on `GATEWAY_URL`; observability cloaks on `AGENT_PROVISIONING_SECRET` |
| Registration order | `controlPlugin` before `mountAgentWs` — Bearer requests fall through correctly |
| Audit events | `control.proxy`, `control.ws_connect`, `control.ws_disconnect` emitted via `obsEmitEvent` |
| Core auth unchanged | No modifications to `packages/core/src/auth/` |

---

## Comparison with Previous Audits

The control plugin is additive to the `/ops` surface established in ADR-008 and extended in ADR-009:

- Password hashing, JWT verification, session management — unchanged, no regressions
- `requireAgentKey` — unchanged; reused by the `/ws` multiplexer for Bearer-auth fallthrough
- `timingSafeEqual` — unchanged since the OBS-4 fix
- HMAC-signed nonces — unchanged since ADR-009 audit
- Fail-open error handling — consistent with existing patterns

The control plugin introduces a new auth model (cookie-based proxy) alongside the existing agent-key model. The `/ws` multiplexer correctly dispatches between them without information leakage.

---

## Verification

```bash
bun run build        # Clean build
bun run typecheck    # No type errors
bun run lint         # No lint violations (152 files checked)
bun run test:unit    # 638 tests passing (33 test files)
```

### Unit tests (638 passing, 33 files)

Relevant suites to this audit:

| Suite | Tests | Security properties covered |
|-------|-------|----------------------------|
| `gateway-url.test.ts` | 7 | SSRF validation: safe URLs, localhost in dev/prod, link-local, metadata endpoints, non-HTTP schemes, invalid URLs |
| `handler.test.ts` | 28 | Backend unavailability, missing gateway, oversized messages, binary frame rejection, token isolation, token injection into connect frames, non-connect passthrough, connect timeout, concurrent connection supersession, cross-user isolation, rate limiting, rate window reset, pending buffer overflow, idle timeout, keepalive via activity, heartbeat ping timeout, session revocation during heartbeat, session check DB error, valid session keepalive, backend message relay, backend disconnect, backend error, cleanup lifecycle, origin forwarding fallback |
| `proxy.test.ts` | 6 | URL rewriting, 502 on gateway error, 502 on network failure, error detail suppression, header stripping, unsafe GATEWAY_URL rejection |
| `ip-allowlist.test.ts` | 7 | Passthrough when disabled, empty list, allow/deny by IP, 404 on rejection, whitespace handling, comma-only list, getClientIp throwing |
| `user-one-guard.test.ts` | 4 | uid=1 allowed, uid=2 blocked, uid=0 blocked, missing payload blocked |

All checks passed at time of audit.
