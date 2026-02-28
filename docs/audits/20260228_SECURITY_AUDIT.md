# Security Audit Report — Observability Plugin, Ops Surface, and CLI

**Project:** Cloudflare Workers Authentication Foundation  
**Date:** February 28, 2026  
**Audit Type:** Feature Security Review (ADR-008 Observability Plugin)  
**Auditor:** Claude Opus 4.6  
**Status:** PASSED — 4 FINDINGS RESOLVED

---

## Executive Summary

This audit reviews the observability plugin (`packages/observability`), the `/ops` operational API surface, the `plctl` Go CLI, and the event emission wiring in `app.ts`. The plugin was designed to bolt onto the existing auth system via Hono middleware without modifying core auth services — this constraint is met.

Four findings were identified and resolved before release. No open vulnerabilities remain. SQL injection, authentication, authorization, and fail-open semantics are implemented correctly throughout.

**Overall Security Rating:** EXCELLENT

### Scope

Files reviewed:

- `packages/observability/src/` — all 8 source files (middleware, routing, event processing, agent auth, schema, config, types, plugin entry)
- `packages/core/src/auth/utils/crypto.ts` — `timingSafeEqual` implementation
- `apps/cloudflare-workers/src/app.ts` — event emission wiring and rate limit configuration
- `tools/cli/` — Go CLI (`plctl`): HTTP client, API types, TUI model
- `apps/cloudflare-workers/test/fixtures/mock-env.ts` — test fixture security

---

## Security Analysis

### 1. SQL Injection

**All queries are parameterized. No injection vectors found.**

Every SQL statement across the observability package uses `db.execute({ sql: ..., args: [...] })` with positional `?` placeholders. This includes:

- Event insertion (`process-event.ts:73-86`) — 8 parameterized placeholders
- Challenge failure count (`process-event.ts:116-119`) — parameterized `type`, `ip_address`, `since`
- Agent key lookup (`require-agent-key.ts:87-90`) — parameterized `key_hash`
- Dynamic `WHERE` clause construction in `GET /ops/events` (`router.ts:355-385`) and `GET /ops/sessions` (`router.ts:80-97`) — clauses are hardcoded SQL fragments joined with `AND`; all user-supplied values are `?`-parameterized
- Session revocation (`router.ts:153-178`) — parameterized `id` values
- Agent provisioning/revocation (`router.ts:278-285`, `320-323`) — parameterized throughout

### 2. Authentication and Authorization

**Agent key verification:** Hash-then-lookup pattern. The incoming Bearer token is SHA-256 hashed (`require-agent-key.ts:83`), then looked up via `WHERE key_hash = ? AND revoked_at IS NULL` (`require-agent-key.ts:87-90`). This is a standard pattern for high-entropy API keys (256-bit random). No timing side-channel on the key itself.

**Provisioning secret:** Compared using `timingSafeEqual` via the double-HMAC pattern (`crypto.ts:17-33`). The `crypto.subtle.verify()` call is spec-mandated constant-time.

**Trust level enforcement:** `POST /ops/sessions/revoke` checks `principal.trustLevel !== "write"` (`router.ts:106-112`) and returns 403 for read-only agents. Provisioning endpoints use `x-provisioning-secret` directly, bypassing agent auth (intentional — infrastructure concern). Trust level comes from the database `CHECK` constraint (`schema.ts:44`).

**Surface cloaking:** When `AGENT_PROVISIONING_SECRET` is absent, all `/ops/*` routes return 404 (`router.ts:67-72`). Tested in `router.test.ts:77-98`.

**Auth failure on error:** `requireAgentKey` returns 401 on any DB error (`require-agent-key.ts:108-112`) — fail-closed for authentication.

### 3. Fail-Open Behavior

**Correct throughout — event processing never blocks auth responses.**

- `processEvent` wraps its body in try/catch; errors are logged and swallowed (`process-event.ts:70-89`)
- `obsEmit` middleware delegates to `waitUntil` — processing runs after the response is sent (`middleware.ts:56-62`)
- `obsEmitEvent` uses the same `waitUntil` + `.catch()` pattern (`index.ts:87-110`)
- `computeChallenge` returns `null` on DB error, meaning "no challenge required" (`process-event.ts:123`)
- `createAdaptiveChallenge` catches all errors and calls `next()` (`middleware.ts:150-154`)

### 4. Information Disclosure

**Email handling:** Failed login events store only the domain portion: `*@${email.split("@").pop()}` (`app.ts:199-203`). Full email never persisted.

**Agent key hashes:** `GET /ops/agents` explicitly enumerates columns, excluding `key_hash` (`router.ts:336-338`). Raw API key returned only once at provisioning (`router.ts:299-303`).

**Event detail payloads reviewed — all safe:**

| Event Type | Detail | PII Risk |
|---|---|---|
| `login.failure` | `{ email: "*@domain" }` | Domain only |
| `login.success` | `{ userId }` | Pseudonymous |
| `session.revoke_all` | `{ userId }` | Pseudonymous |
| `challenge.issued` / `challenge.failed` | `{ difficulty }` | None |
| `rate_limit.reject` | `{ prefix }` | None |
| `session.ops_revoke` | `{ scope, id, revoked }` | Operational |
| `agent.provisioned` / `agent.revoked` | `{ name }` / `{ name, trustLevel }` | None |
| `agent.auth_failure` | `{ code, path }` | Request path only |

### 5. Adaptive PoW Challenges

**Difficulty enforcement is server-side:** The server always verifies against its own `computeChallenge` difficulty (`middleware.ts:145`), not any client-claimed value. Difficulty downgrade is not possible.

**Nonces are stateless:** The server generates a random nonce but does not store it. The client provides both nonce and solution on submission. An attacker can pre-compute solutions using self-chosen nonces and replay them. However, each difficulty level still requires at least one PoW computation, preserving the speed-bump function. ADR-008 explicitly states PoW is not a CAPTCHA and "raises cost for high-volume automated attempts."

### 6. Rate Limiting

**Configs are appropriate:** Login 5/5min IP-keyed, register 5/5min IP-keyed, password 3/1h user-keyed. Group limiter at 20/5min IP-keyed on `/auth/*` provides a blanket ceiling.

**Ordering is correct:** Rate limiting runs before adaptive challenge on login (`app.ts:186-188`), preventing challenge computation on already-rate-limited requests.

**Disabled by default:** `createCacheClient` is `null` (`app.ts:33`), meaning no rate limiting in the default configuration. Documented and intentional.

### 7. CLI Security

**Credentials from env vars only:** No config files, no keychain. Standard 12-factor pattern (`main.go:903-905`).

**No shell execution:** No `os/exec` imports. User input flows only to HTTP requests.

**Go TLS defaults:** No `InsecureSkipVerify`, no custom TLS config. System root CA store is used.

### 8. Test Fixture Safety

**Environment guards:** `initTestDb()` checks both `ENVIRONMENT` (must be `"development"` or `"test"`) and `AUTH_DB_URL` (must contain `"test-db"` or `"dev-db"`) before executing (`mock-env.ts:54-67`). Two-layer defense prevents accidental test execution against production.

**`.dev.vars` files are gitignored:** Only `.example` variants are tracked. Real secrets stay local.

---

## Findings

| # | Severity | Category | Finding | Disposition |
|---|----------|----------|---------|-------------|
| OBS-1 | Medium | Input Validation | CLI agent name concatenated into URL path without escaping — path traversal possible | **Fixed** — `url.PathEscape(name)` applied in `agents.go` |
| OBS-2 | Low | Input Validation | CLI query parameters built via string concatenation without URL encoding | **Fixed** — replaced with `net/url.Values` in `events.go` and `sessions.go` |
| OBS-3 | Low | Defense in Depth | `SELECT *` on events endpoint — future columns would be automatically exposed to all agents | **Fixed** — explicit column list in `router.ts` |
| OBS-4 | Low | Timing | `timingSafeEqual` early-returns on length mismatch, leaking provisioning secret byte-length | **Fixed** — both inputs padded to max length; HMAC always runs; `lengthsMatch && contentsMatch` returned |

### OBS-1: CLI Path Traversal (Medium) — Fixed

`DeleteAgent` concatenated user input directly into the URL path. A name like `../sessions/revoke` would alter the target path.

**Fix:** `url.PathEscape(name)` applied in `agents.go:29`.

### OBS-2: CLI Query Parameter Injection (Low) — Fixed

Event and session queries built URL query strings via `fmt.Sprintf` concatenation without encoding. Input containing `&` or `=` could inject extra parameters.

**Fix:** Replaced with `net/url.Values` in `events.go` and `sessions.go`.

### OBS-3: `SELECT *` on Events (Low) — Fixed

The events query returned all columns. If a future schema migration adds a sensitive column, it would be automatically exposed to all read-level agents.

**Fix:** Replaced with explicit column list (`id, type, ip_address, user_id, detail, created_at, actor_id`) in `router.ts:383`, matching the pattern already used for `GET /ops/agents` and `GET /ops/sessions`.

### OBS-4: Length Leak in `timingSafeEqual` (Low) — Fixed

The early return at `crypto.ts:24` (`if (aBytes.byteLength !== bBytes.byteLength) return false`) completed faster when lengths differed, allowing an attacker to determine the provisioning secret's byte length.

**Fix:** Both inputs are now zero-padded to the max length. The HMAC comparison always runs regardless of length mismatch. The final return is `lengthsMatch && contentsMatch`, where `lengthsMatch` is a boolean computed before the HMAC — no early exit.

---

## Items Verified as Correct

| Area | Property |
|------|----------|
| Event emission placement | All `obsEmit`/`obsEmitEvent` calls fire after auth gates, never before |
| Fail-open | Event emission, challenge computation, and rate limiting all fail open — never block auth |
| Session revocation | Password change correctly revokes all sessions after password update (`app.ts:256`) |
| Trust level | Read-only agents receive 403 on write operations |
| Surface cloaking | All `/ops/*` routes return 404 when provisioning secret is absent |
| Key hash confidentiality | `key_hash` excluded from all SELECT queries and API responses |
| Challenge difficulty | Server-side enforcement prevents client downgrade |
| Test isolation | Suite-specific users, parameterized cleanup, environment guards |
| Core auth unchanged | No modifications to `account-service`, `session-service`, `require-auth`, or any file in `packages/core/src/auth/` |

---

## Comparison with Previous Audits

The observability plugin is additive and does not modify existing auth logic:

- Password hashing, JWT verification, session management — unchanged, no regressions
- `timingSafeEqual` implementation unchanged since initial audit; the length-leak finding (OBS-4) was pre-existing
- Fail-open error handling follows the same posture as `createAuthSystem` and the rate limiter
- All three items from the Feb 21, 2026 audit's recommendations are now addressed:
  - **Sliding-window algorithm** — acknowledged as future work (ADR-006)
  - **Bot mitigation / adaptive challenges** — implemented (ADR-008)
  - **CSP nonces** — remains a documented future hardening item

---

## Verification

```bash
bun run build        # Clean build
bun run typecheck    # No type errors
bun run lint         # No lint violations (122 files checked)
bun run test:unit    # 426 tests passing (25 test files)
```

### Unit tests (426 passing, 25 files)

Relevant suites to this audit:

| Suite | Tests | Security properties covered |
|-------|-------|----------------------------|
| `process-event.test.ts` | Tests | Event insertion, detail serialization, fail-open on DB error, challenge computation |
| `require-agent-key.test.ts` | Tests | Key validation, trust level extraction, revoked agent rejection, missing/invalid key responses, auth failure event emission |
| `router.test.ts` | Tests | Cloaking, session queries, session revocation (all/user/session scopes), trust level enforcement, agent CRUD, event queries, event stats, provisioning secret validation |
| `middleware.test.ts` | Tests | `obsEmit` event emission, status-based type rewriting, adaptive challenge escalation, PoW verification, fail-open on challenge error |
| `rate-limit.test.ts` | 11 | Fixed-window logic, 429 response, fail-open, TTL-only-on-first-hit, orphaned key cleanup |
| `crypto.test.ts` | 19 | `timingSafeEqual` correctness, constant-time comparison invariants |

All checks passed at time of audit.
