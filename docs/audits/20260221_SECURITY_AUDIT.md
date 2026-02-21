# Security Audit Report - Rate Limiting Middleware & Wizard UI

**Project:** Cloudflare Workers Authentication Foundation  
**Date:** February 21, 2026  
**Audit Type:** Feature Security Review (ADR-006 Rate Limiting) + Stop-gap UI Review (v1.3.0)  
**Auditor:** Claude Opus 4.6  
**Status:** PASSED - 2 FINDINGS RESOLVED

---

## Executive Summary

This audit reviews the fixed-window rate limiting middleware introduced in ADR-006. The implementation adds `createRateLimiter` backed by the `CacheClient` abstraction, with IP-keyed limits on public auth routes and user ID-keyed limits on authenticated routes. The review covers the middleware, key extraction logic, app-level wiring, test suite, and alignment with ADR-006.

Two findings were identified and resolved before release. No open vulnerabilities remain.

**Overall Security Rating:** EXCELLENT

### Scope

Files reviewed:

- `packages/core/src/auth/middleware/rate-limit.ts` — `createRateLimiter` factory
- `packages/core/src/auth/middleware/security.ts` — Security headers middleware
- `packages/core/src/auth/utils/get-client-ip.ts` — IP extraction from Cloudflare context
- `packages/infrastructure/src/cache/memory-client.ts` — In-memory test double
- `packages/infrastructure/src/cache/valkey-client.ts` — Production cache client
- `packages/core/test/rate-limit.test.ts` — Unit test suite (9 tests)
- `packages/core/test/security-headers.test.ts` — Security headers test suite (21 tests)
- `apps/cloudflare-workers/src/app.ts` — Route wiring and limit configuration
- `apps/cloudflare-workers/public/index.html` — Wizard UI (supplemental review)
- `docs/adr/006-rate-limiting.md` — Design record

---

## Security Analysis

### 1. Algorithm Correctness

**Fixed-window counter logic**
The implementation uses an increment-first pattern: `count = await cache.incr(key)` returns the post-increment value, then blocks when `count > max`. This allows exactly `max` requests per window with no off-by-one errors. The TTL is set only on the first hit (`count === 1`), avoiding an unnecessary `EXPIRE` call on every subsequent request.

**Window reset behavior**
After `windowSeconds` elapse the key expires and the next request resets the counter to 1. A fixed-window counter can allow up to 2× `max` requests in a period spanning a window boundary (e.g., `max` requests at T=299s and `max` more at T=300s). This is an inherent property of fixed-window counters and is explicitly acknowledged and accepted in ADR-006.

### 2. IP Extraction and Spoofing Resistance

**`getClientIp` uses `getConnInfo(ctx)`**
The Hono Cloudflare Workers adapter reads `cf-connecting-ip`, which is set by Cloudflare's edge infrastructure before the Worker executes. Client requests cannot inject or override this header — it is stripped and rewritten at the edge.

Common spoofing vectors (`X-Forwarded-For`, `X-Real-IP`, `X-Client-IP`) are not consulted by `getClientIp`. The implementation is correctly scoped to Cloudflare Workers deployment and is not vulnerable to header-based IP spoofing.

**Unknown IP fallback**
When the Cloudflare connection info is unavailable (e.g., misconfigured or local dev without `wrangler dev`), `getClientIp` returns `"unknown"`. All such requests share one rate-limit bucket keyed `<prefix>:unknown`. This degrades gracefully rather than crashing and is only reachable in non-production configurations.

### 3. Cache Key Design

**Prefix injection**
All prefixes (`rl:auth`, `rl:login`, `rl:register`, `rl:logout`, `rl:password`) are compile-time constants in `app.ts` — not derived from user input. No injection path exists.

**Identifier values**
- IP identifiers come from Cloudflare's trusted infrastructure (see §2)
- User IDs come from JWT payload claims (`payload.uid`), which are cryptographically signed by the server

Even if an identifier contains the `:` separator character, Redis treats the full concatenated string as a single opaque key. There is no parsing or interpretation of the key structure that could be exploited.

### 4. Fail-Open Behavior

The middleware wraps all cache operations in a `try/catch`. On any error it logs via `console.error` and calls `await next()`, allowing the request through.

This design prioritizes availability over rate-enforcement during cache outages, which is the correct trade-off for an auth service — locking out legitimate users due to a cache failure would be a worse outcome than temporarily disabling rate limiting. The posture is documented in ADR-006.

**Partial-failure atomicity (Finding RL-1/RL-7 — resolved):** The original implementation called `cache.expire(key, windowSeconds)` bare inside the `count === 1` branch. If `expire` succeeded but then the key had no TTL set (e.g., `expire` threw after `incr` returned 1), the counter key would persist indefinitely, permanently locking out the key's identifier. This was fixed: `expire` is now wrapped in a nested try/catch that calls `cache.del(key)` on failure before re-logging, ensuring the orphaned key is cleaned up immediately rather than waiting for LRU eviction. The outer fail-open catch remains unchanged — a failure of the del() itself is swallowed as best-effort.

### 5. No-Op Path Wiring

When `createCacheClient` is `null` in `app.ts`, `createRateLimiter(null)` returns a factory that produces pass-through no-op middleware. Every `rateLimit(config)` call in route definitions resolves to `async (_ctx, next) => next()`. No rate limiting state is created or checked.

This is the correct default for the educational reference — enabling rate limiting requires an explicit code change (setting `createCacheClient` to a real factory), preventing accidental deployment with an unconfigured or absent cache.

### 6. Route Ordering

`POST /auth/logout` is registered **before** `app.use("/auth/*", rateLimit(rateLimits.auth))`. This is deliberate: the logout route uses user ID–based keying rather than IP-based keying, so authenticated users behind shared NAT are not locked out by the IP-scoped group limiter. The ordering matches the requirement specified in ADR-006.

**Verification of RL-10 (false positive):** A concern was raised that the group limiter at `app.use("/auth/*", ...)` might also execute on logout requests, subjecting them to double rate-limiting. Hono source was inspected to verify: `hono-base.js` confirms that `app.use()` and `app.post()` both add handlers to the same router in strict registration order. `compose.js` confirms that each handler receives `() => dispatch(i + 1)` as `next` — if the handler returns without calling `next()`, the chain stops and no subsequent handlers run. The logout handler (registered at line 74) returns a response directly; the group limiter (registered at line 100) is never reached on logout requests. The concern is a false positive.

### 7. Response Information Disclosure

The 429 response body is `{ "error": "Too many requests", "code": "RATE_LIMIT" }` regardless of which limit triggered. It does not reveal whether a username exists, which specific limit was hit, or the current counter value. The `Retry-After` header discloses only the window size in seconds, which is public information (the same for all callers hitting a given route).

### 8. Test Coverage

Nine unit tests cover the core paths using `createMemoryCacheClient()` — no external Redis/Valkey required:

| Test | Coverage |
|------|---------|
| Allows requests within the limit | Core increment logic |
| Returns 429 when limit exceeded | Block threshold (`count > max`) |
| Sets `Retry-After` header on 429 | Response format |
| Isolates keys by prefix | Namespace separation |
| Isolates keys by client IP | IP-based keying |
| Custom key extractor (user ID) | User-based keying |
| No-op when `deps` is null | Null factory path |
| Fails open when cache throws | Error handling |
| Sets TTL only on first hit | EXPIRE call count |

Gaps that are acceptable for this scope: window-boundary burst behaviour (requires timing control), real Redis atomicity under concurrent load (JavaScript is single-threaded; Redis INCR is atomic), and the `unknown` IP fallback path.

---

## Findings

| # | Category | Finding | Confidence | Disposition |
|---|----------|---------|------------|-------------|
| RL-1/RL-7 | Reliability / Security | INCR+EXPIRE non-atomicity: if `expire` throws after `incr` returns 1, key has no TTL and the identifier is permanently locked out | 8/10 | **Fixed** — `expire` wrapped in nested try/catch; `cache.del(key)` called on failure to remove the orphaned key immediately (commit `2e58281`) |
| RL-10 | Route Ordering | Group limiter `app.use("/auth/*", ...)` might double-rate-limit logout | 4/10 | **False positive** — Hono `compose.js` confirms handler chain stops when a handler returns without calling `next()`; logout handler returns before group limiter is reached |
| UI-6 | CSP | `'unsafe-eval'` present in `script-src` directive; nothing in the codebase uses `eval()`, `Function()`, or `setTimeout(string)` | 7/10 | **Fixed** — `'unsafe-eval'` removed from CSP; `security-headers.test.ts` updated to assert its absence (commit `4a3343d`) |
| IP-ROT | Coverage | IP-rotation allows distributed bypass of per-IP limits | 2/10 | Accepted — acknowledged in ADR-006; requires attacker infrastructure; per-user keying on sensitive routes (password change, logout) limits exposure even if bypass is achieved on public routes |

---

## Comparison with Previous Audits

The rate limiting implementation is additive and does not modify existing auth logic:

- Password hashing, JWT verification, session management — unchanged, no regressions
- Cache key construction uses server-generated values only (IP from Cloudflare edge, user ID from signed JWT) — consistent with the pattern established in the Feb 14, 2026 audit of the cache layer
- Fail-open error handling follows the same posture as `createAuthSystem` — cache outage does not degrade core auth
- Finding #2 from the Feb 15, 2026 audit ("No rate limiting on password change endpoint") is now resolved

---

## Recommendations

Optional hardening for future consideration:

1. **Sliding-window algorithm** — a sliding log or sliding window counter eliminates the boundary burst; adds cache complexity ([ADR-006 Future Considerations](../adr/006-rate-limiting.md))
2. **Bot mitigation / CAPTCHA** — as noted in README Production Next Steps, adaptive challenges provide defence in depth beyond IP-based throttling
3. **CSP nonces for inline scripts** — current CSP retains `'unsafe-inline'` for the wizard UI's inline script block; nonce-based CSP would eliminate this directive but requires server-side nonce injection per response (out of scope for this educational reference)

---

---

## Supplemental Review: Wizard UI (v1.3.0 + fix 86bb75d)

The tabbed wizard UI introduced in v1.3.0 shipped without a dedicated security review. This section provides stop-gap coverage. One follow-up fix (`fix(ui): check auth on click only`, commit `86bb75d`) was applied in the same cycle and is included in scope.

**File reviewed:** `apps/cloudflare-workers/public/index.html`

### Architecture

The UI is a single self-contained HTML file with inline CSS and a single inline `<script>` block defining three Web Components: `<api-console>`, `<auth-step>`, and `<auth-wizard>`. All component state lives in Shadow DOM instances. The page supports progressive enhancement — native `<form>` submissions work without JavaScript, with fragment-based status banners rendered via CSS `:target`.

### DOM Injection / XSS

Every write to the DOM uses `textContent`, `createElement`, or `replaceChildren` with structured element trees. No `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval`, `Function()`, or `document.write` calls exist anywhere in the file. Server response bodies are rendered via `bodyEl.textContent = JSON.stringify(data, null, 2)` — string-escaped through the JSON serialiser before assignment. **No XSS vectors found.**

### Credential Handling

Passwords are collected from `<input type="password">` fields and sent as a JSON body via `fetch()`. On a successful server response `form.reset()` is called immediately, clearing all field values from the DOM. No credentials are written to `localStorage`, `sessionStorage`, cookies, or any other persistent browser store. HttpOnly auth cookies are managed exclusively by the server and are not accessible to the page JavaScript. **No credential retention issues found.**

### Network Requests

All `fetch()` calls target relative paths (`/auth/login`, `/auth/logout`, etc.) with no explicit `credentials` option, which defaults to `same-origin`. No cross-origin requests are made. The `Accept: application/json` header is included on every request, triggering the server's JSON content-negotiation path. Request bodies use `Content-Type: application/json`, which cannot be sent by a plain HTML form, providing an additional layer of CSRF resistance on top of the `SameSite=Strict` cookie policy.

### Auth State Inference

The `_updateAuthState` method updates the badge label based solely on `{ path, ok }` from the server's own response — it reads no cookies, no tokens, and no response headers beyond the status code. The inferred state (`unauthenticated`, `registered`, `authenticated`) is held in a component instance variable, not persisted anywhere, and resets on page reload.

### The `fix(ui): check auth on click only` Regression Fix

Prior to commit `86bb75d`, `connectedCallback` called `this._checkAuthStatus()` immediately on component mount, firing a GET `/account/me` on every page load regardless of user intent. This was removed; the check now runs only when the user clicks the auth status badge. The original behaviour was not a security vulnerability but was incorrect: the eager probe could display a misleading `unauthenticated` flash before the user interacted, and generated unnecessary credentialed requests on every visit.

### CSP Compliance

The server's `Content-Security-Policy` header includes `script-src 'self' 'unsafe-inline'` to accommodate the inline `<script>` block. `'unsafe-eval'` was identified during this audit as present in the CSP but unrequired — no `eval()`, `Function()`, or `setTimeout(string)` calls exist anywhere in the codebase. It was removed (Finding UI-6, commit `4a3343d`). The remaining `'unsafe-inline'` is a known gap documented in the README production next steps ("CSP nonces for inline scripts"). Moving to a nonce-based CSP would eliminate it but requires server-side nonce injection per response — out of scope for this educational reference implementation.

### Findings

| # | Category | Finding | Confidence | Disposition |
|---|----------|---------|------------|-------------|
| UI-6 | CSP | `'unsafe-eval'` present in `script-src`; not required by any code in the project | 7/10 | **Fixed** — removed from CSP in `security.ts`; test updated to assert absence (commit `4a3343d`) |
| UI-CSP | CSP | `'unsafe-inline'` required for inline script block | 1/10 | Accepted — documented in README; no XSS risk in the inline code; nonce migration is a future hardening item |

No other vulnerabilities found. No regressions introduced by the v1.3.0 UI or the subsequent fix.

---

## Verification

```bash
bun run build        # Clean build
bun run typecheck    # No type errors
bun run lint         # No lint violations
bun run test:unit    # 325 tests passing
bun run test:integration  # 63 tests passing
```

### Unit tests (325 passing, 17 files)

Relevant suites to this audit:

| Suite | Tests | Security properties covered |
|-------|-------|----------------------------|
| `rate-limit.test.ts` | 9 | Fixed-window logic, 429 response, Retry-After header, prefix isolation, IP isolation, custom key extractor, no-op path, fail-open on cache error, TTL set once |
| `security-headers.test.ts` | 21 | HSTS, CSP (`unsafe-eval` absence asserted), CORP/COEP/COOP, Permissions-Policy, fingerprint header removal |
| `jwt-attack-vectors.test.ts` | 25 | Algorithm confusion (`alg: none`, RS256/HS256 confusion), signature tampering, type confusion (refresh as access), expired tokens |
| `auth-edge-cases.test.ts` | 20 | Timing-safe rejection, Unicode normalisation, session linkage, boundary conditions |
| `require-auth.test.ts` | 12 | Middleware flow: valid token, expired access + valid refresh, revoked session rejection |
| `session-service.test.ts` | 22 | Session creation, sliding expiration, limit enforcement (post-insert), cleanup |
| `crypto.test.ts` | 19 | `timingSafeEqual` correctness, constant-time comparison invariants |
| `account-service.test.ts` | 29 | Registration, authentication, constant-time dummy PBKDF2 path, error message parity |
| `password-service.test.ts` | 30 | PBKDF2-SHA384 hash/verify, integrity digest, version parsing, compromise checks |

### Integration tests (63 passing, 11 files)

Run inside an isolated Cloudflare Workers runtime against a live Turso database. Named tests confirm end-to-end security properties:

| Test | Security property verified |
|------|---------------------------|
| `should reject duplicate email registration` | Anti-enumeration: duplicate accounts return a generic error, not a user-existence signal |
| `should reject invalid password` | Authentication failure path returns consistent error without revealing account state |
| `should reject non-existent user` | Timing-safe rejection: non-existent user returns same response shape as wrong password |
| `should set auth cookies on successful login` | Cookies are set with correct attributes (HttpOnly, Secure, SameSite) |
| `should invalidate session after logout` | Server-side session revocation: re-using a token after logout returns 401 |
| `should reject revoked sessions` | Session–JWT linkage: a valid JWT for a revoked session is refused |
| `should refresh access token using refresh token` | Refresh flow generates a new access token without requiring re-login |
| `returns generic error for duplicate email (anti-enumeration)` | JSON API path: same generic error regardless of whether email exists |
| `returns 401 for non-existent user (anti-enumeration)` | JSON API login: non-existent user and wrong password return identical 401 |
| `should change password successfully (JSON)` | Full password change flow completes and returns success |
| `should invalidate all sessions after change` | Password change revokes every session for the user, including the current one |
| `should allow login with new password` | New credential is accepted; old credential is implicitly invalidated |
| `should reject incorrect current password` | Current password re-verification gate cannot be bypassed |
| `should reject same new/current password` | Schema cross-field refinement blocks no-op password changes |
| `should require authentication (no cookies → 401)` | Password change endpoint is protected by `requireAuth` middleware |

All checks passed at time of audit.
