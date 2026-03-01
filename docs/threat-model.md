# Threat Model

STRIDE analysis and JWT pitfall catalogue for Private Landing. This document is educational — it maps each threat to the specific mitigation in the codebase (or flags the gap).

> **Prerequisite reading:** [ADR-001](adr/001-auth-implementation.md) for architecture decisions, [flows.md](flows.md) for sequence diagrams.

---

## STRIDE Threat Analysis

| # | Category | Threat | Component | Mitigation | Residual Risk |
|---|----------|--------|-----------|------------|---------------|
| 1 | **Spoofing** | JWT forgery via `alg: "none"` | `require-auth.ts:176` | `verify()` called with explicit `AlgorithmTypes.HS256` — rejects any other algorithm | None if Hono JWT library is kept up to date |
| 2 | **Spoofing** | JWT forgery via algorithm confusion (RSA/HMAC) | `require-auth.ts:176` | Same explicit `AlgorithmTypes.HS256` parameter; Hono >=4.11.4 rejects mismatched algorithms | Depends on Hono patch level — pin and audit |
| 3 | **Spoofing** | Timing-based user enumeration | `account-service.ts:174-179` | `rejectPasswordWithConstantTime()` runs full PBKDF2 against a dummy hash when the user doesn't exist, equalizing response time | Statistical analysis with many requests may still detect small differences |
| 4 | **Spoofing** | User enumeration via error messages | `account-service.ts:178, 196` | Both "user not found" and "wrong password" return the same `"Invalid email or password"` string | None — identical error paths |
| 5 | **Spoofing** | Token type confusion (refresh as access) | `require-auth.ts:179-181` | `verifyToken()` checks `payload.typ` matches expected type; access and refresh tokens use separate signing secrets | None with current design |
| 6 | **Tampering** | JWT payload modification | `require-auth.ts:173-177` | HMAC-SHA256 signature verification via `hono/jwt verify()` — any payload change invalidates the signature | None — HMAC provides integrity |
| 7 | **Tampering** | Cookie manipulation | `cookie.ts:25-31` | Cookies set with `httpOnly: true`, `secure: true`, `sameSite: "Strict"`, `path: "/"` | XSS in a subdomain could access `path=/` cookies if `sameSite` is relaxed in the future |
| 8 | **Tampering** | Password hash tampering in database | `password-service.ts:261-300` | `verifyPassword()` performs both PBKDF2 hash comparison and SHA-384 integrity digest verification via `timingSafeEqual`; both must pass | An attacker with direct DB write access could replace both hash and digest consistently |
| 9 | **Repudiation** | No audit trail for auth events | `middleware.ts`, `002_observability.sql` | **Mitigated** ([ADR-008](adr/008-adaptive-challenges-ops.md)): Observability plugin persists security events (`login.success/failure`, `session.revoke`, `password.change`, `rate_limit.reject`, etc.) to the `security_event` table with `actor_id` attribution. Emission is fire-and-forget via `waitUntil` — a failed write never blocks auth. | Fail-open semantics mean events can be silently lost under DB pressure; no event pruning or retention policy — table grows indefinitely |
| 10 | **Information Disclosure** | Error message leakage | `account-service.ts:178, 196, 241, 255`, `require-auth.ts:107-121` | Generic error messages; no stack traces in JSON responses; `AuthenticationError` uses sanitized `code` field; password change returns same `"Password change failed"` for missing user and wrong password | None in current error paths |
| 11 | **Information Disclosure** | Server header fingerprinting | `security.ts:122-125` | `Server`, `X-Powered-By`, `X-AspNet-Version`, `X-AspNetMvc-Version` headers explicitly deleted | None — headers removed after every response |
| 12 | **Information Disclosure** | Secrets in JWT payload | `token-service.ts:77-94` | Payload contains only `uid`, `sid`, `typ`, `exp` — no email, role, or sensitive data | None — minimal claims |
| 13 | **Denial of Service** | Brute-force / credential stuffing on login | `app.ts`, `rate-limit.ts`, `middleware.ts` | **Mitigated:** Fixed-window rate limiting ([ADR-006](adr/006-rate-limiting.md)). IP-keyed for public endpoints (5 login/300s), user-keyed for protected actions. No hard lockouts (per NIST §5.2.2). Adaptive PoW challenges ([ADR-008](adr/008-adaptive-challenges-ops.md)) escalate difficulty after 3+ failures from the same IP within 15 minutes — complements rate limits by raising per-request cost. | PoW fails open on DB error (challenge bypassed under DB pressure); IP-only keying means distributed attacks below per-IP threshold are not challenged; PoW does not distinguish humans from bots — raises cost but does not stop well-resourced attackers |
| 14 | **Denial of Service** | Session exhaustion | `session-service.ts:171-194` | `enforceSessionLimit()` caps sessions at 3 per user via CTE + ROW_NUMBER; expired sessions cleaned before each create | An attacker with valid credentials can only hold 3 sessions |
| 15 | **Elevation of Privilege** | Missing `aud` claim in JWT | `token-service.ts:77-94` | **Gap**: No `aud` (audience) claim in tokens | If multiple services share the same secret, a token from one service could be accepted by another |
| 16 | **Elevation of Privilege** | Cross-secret token acceptance | `require-auth.ts:169-172` | Access tokens verified with `JWT_ACCESS_SECRET`, refresh tokens with `JWT_REFRESH_SECRET` — separate secrets | None — secrets are isolated per token type |
| 17 | **Spoofing** | Credential takeover via stolen session | `account-service.ts:215-268` | `changePassword()` requires current password re-verification even for authenticated users; `endAllSessionsForUser()` revokes all sessions after change ([ADR-004](adr/004-password-change-endpoint.md)) | Rate limiting depends on optional cache layer (ADR-003); without it, current password requirement + constant-time comparison are the only brute-force controls |
| 18 | **Tampering** | Race condition during password change | `account-service.ts:247-251` | Password update is a single `UPDATE ... WHERE id = ?` — SQLite serializes writes; `endAllSessionsForUser` runs after the update ensuring no session outlives the old credential | None — write serialization prevents concurrent hash corruption |

### Observability Plugin Surface

> The threats below apply only when `packages/observability` is mounted. The plugin is removable — deleting the package and commenting the two `[obs-plugin]` lines in `app.ts` eliminates this entire attack surface ([ADR-008](adr/008-adaptive-challenges-ops.md)). CI [verifies](../.github/workflows/ci.yml) that the core build and tests pass with those lines removed.

| # | Category | Threat | Component | Mitigation | Residual Risk |
|---|----------|--------|-----------|------------|---------------|
| 19 | **Spoofing** | Agent key compromise | `require-agent-key.ts` | Keys are 256-bit random, SHA-256 hashed before storage, looked up via parameterized query; `revoked_at IS NULL` filter rejects revoked keys; auth failures emit `agent.auth_failure` events; all `/ops/*` routes cloak behind 404 when `AGENT_PROVISIONING_SECRET` is absent | Keys are long-lived with no expiration — exposure window is unbounded until explicit revocation; no key rotation mechanism (provision new + revoke old) |
| 20 | **Spoofing** | Provisioning secret compromise | `router.ts` | `AGENT_PROVISIONING_SECRET` checked via `timingSafeEqual` (constant-time, length-padded per OBS-4 fix); gates `POST /ops/agents` and `DELETE /ops/agents/:name` only | Single static env var with no rotation mechanism; compromise allows minting write-level agents with full session revocation power |
| 21 | **Tampering** | PoW stateless nonce replay | `middleware.ts` | Nonces are generated randomly per-request; server re-computes difficulty from event history on the verification request (never trusts client-claimed difficulty) | Stateless design means attacker can pre-compute solutions with self-chosen nonces; each difficulty level still requires one hash computation, but the same solution can be reused across requests |
| 22 | **Tampering** | Cache/SQL session consistency | `mirrored-session-service.ts` | SQL mirror runs after each cache mutation (`createSession`, `endSession`, `endAllSessionsForUser`); cache is authoritative for `requireAuth`, SQL provides ops visibility | SQL mirror is best-effort (failures caught and logged, never block auth); a consistency gap means `/ops/sessions` may not reflect a valid cache-only session — ops agents cannot see or revoke it until mirror catches up |
| 23 | **Information Disclosure** | Operational data exposure via `/ops/*` | `router.ts` | Agent key auth (`requireAgentKey`) gates all data endpoints; trust levels enforce read vs write separation; key hashes never exposed in agent listings; failed login events store only the email domain (`*@example.com`) | A compromised read-level key exposes all users' session metadata (IP addresses, user agents, timestamps) and security event history (IPs, user IDs, event details) |
| 24 | **Information Disclosure** | Unbounded `security_event` retention | `002_observability.sql` | Manual 90-day pruning command documented in [ADR-008](adr/008-adaptive-challenges-ops.md); no automated trigger | Retention depends on operator discipline; without scheduled execution, the table grows indefinitely — expanding the exposure surface of IP addresses, user agents, and event details |
| 25 | **Denial of Service** | Global session revocation via agent | `POST /ops/sessions/revoke` | Requires write-level agent key; revocation emits `session.ops_revoke` event with agent attribution; three graduated scopes (`session`, `user`, `all`) | A compromised write-level key can revoke every active user session in one call (`scope: "all"`); intentional for incident response but significant DoS vector |
| 26 | **Denial of Service** | `/ops/*` endpoints not rate limited | `router.ts` | Justified by 256-bit key entropy (brute-force infeasible); `agent.auth_failure` events surface unauthorized attempts; revocation is the primary control | A compromised read-level key has no query throttle — high-volume queries could degrade DB performance |
| 27 | **Elevation of Privilege** | Trust level escalation via provisioning secret | `router.ts` | Agent keys and provisioning secret are separate credentials; trust levels (`read`/`write`) enforced per-route; agent provisioning is an infrastructure concern distinct from runtime access | Read-level key + provisioning secret = ability to mint write-level agents; both are static env vars stored alongside each other |

---

## JWT Pitfalls — Naive vs This Project

| Pitfall | Naive Approach | This Project | Reference |
|---------|---------------|--------------|-----------|
| **Algorithm confusion** | Accept whatever `alg` the token header says, including `"none"` | Explicit `AlgorithmTypes.HS256` parameter to `verify()` — ignores token header's `alg` claim | [`require-auth.ts:176`](../packages/core/src/auth/middleware/require-auth.ts), [RFC 8725 §2.1](https://datatracker.ietf.org/doc/html/rfc8725#section-2.1) |
| **Shared secret for all token types** | One `JWT_SECRET` for everything | Separate `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET`; `typ` claim validated in `verifyToken()` | [`require-auth.ts:169-181`](../packages/core/src/auth/middleware/require-auth.ts), [`token-service.ts:84-97`](../packages/core/src/auth/services/token-service.ts) |
| **No token type discrimination** | Accept any valid JWT in any context | `payload.typ` must match expected type (`"access"` or `"refresh"`) or request is rejected | [`require-auth.ts:179-181`](../packages/core/src/auth/middleware/require-auth.ts) |
| **Irrevocable tokens** | Stateless JWTs with no server-side check | Every token contains `sid` (session ID); `isValidSession()` checks the session exists and matches before granting access | [`require-auth.ts:59-65`](../packages/core/src/auth/middleware/require-auth.ts), [`session-service.ts:270-296`](../packages/core/src/auth/services/session-service.ts) |
| **Long-lived access tokens** | 24h or 7d access tokens | 15-minute access tokens; 7-day refresh tokens trigger automatic refresh flow | [`token-service.ts:90-94`](../packages/core/src/auth/services/token-service.ts) (900s), [`require-auth.ts:85-103`](../packages/core/src/auth/middleware/require-auth.ts) |
| **Secrets in payload** | Store email, role, permissions in JWT claims | Minimal payload: `uid`, `sid`, `typ`, `exp` only — all other data fetched server-side | [`token-service.ts:77-94`](../packages/core/src/auth/services/token-service.ts) |
| **Missing expiration** | No `exp` claim; tokens valid forever | `exp` set on both access and refresh tokens; `hono/jwt verify()` rejects expired tokens automatically | [`token-service.ts:81, 94`](../packages/core/src/auth/services/token-service.ts) |
| **Tokens in localStorage** | `localStorage.setItem("token", jwt)` — accessible to any XSS | HTTP-only, Secure, SameSite=Strict cookies — JavaScript cannot read them | [`cookie.ts:25-31`](../packages/core/src/auth/utils/cookie.ts) |

---

## References

- [OWASP ASVS v5.0](https://github.com/OWASP/ASVS/tree/v5.0.0) — Application Security Verification Standard
- [NIST SP 800-63B](https://pages.nist.gov/800-63-3/sp800-63b.html) — Digital Identity Guidelines: Authentication and Lifecycle Management
- [STRIDE Threat Model](https://learn.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-threats) — Microsoft Threat Modeling methodology
- [RFC 7519](https://datatracker.ietf.org/doc/html/rfc7519) — JSON Web Token (JWT)
- [RFC 8725](https://datatracker.ietf.org/doc/html/rfc8725) — JSON Web Token Best Current Practices
- [RFC 6819](https://datatracker.ietf.org/doc/html/rfc6819) — OAuth 2.0 Threat Model and Security Considerations
- [NIST SP 800-132](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-132.pdf) — Recommendation for Password-Based Key Derivation
- [ADR-007: Session Dual-Write](adr/007-session-dual-write.md) — Cache/SQL mirrored session architecture
- [ADR-008: Adaptive Challenges and Operational Surface](adr/008-adaptive-challenges-ops.md) — Observability plugin, PoW challenges, agent auth, `/ops/*` API
- [Security Audit — Feb 28, 2026](audits/20260228_SECURITY_AUDIT.md) — OBS-1 through OBS-4 findings and remediations
