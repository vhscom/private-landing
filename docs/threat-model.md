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
| 9 | **Repudiation** | No audit trail for auth events | — | **Gap**: Login, logout, and session creation are not logged to a persistent audit store | Add structured audit logging (see [Production Next Steps](../README.md)) |
| 10 | **Information Disclosure** | Error message leakage | `account-service.ts:178, 196, 241, 255`, `require-auth.ts:107-121` | Generic error messages; no stack traces in JSON responses; `AuthenticationError` uses sanitized `code` field; password change returns same `"Password change failed"` for missing user and wrong password | None in current error paths |
| 11 | **Information Disclosure** | Server header fingerprinting | `security.ts:122-125` | `Server`, `X-Powered-By`, `X-AspNet-Version`, `X-AspNetMvc-Version` headers explicitly deleted | None — headers removed after every response |
| 12 | **Information Disclosure** | Secrets in JWT payload | `token-service.ts:77-94` | Payload contains only `uid`, `sid`, `typ`, `exp` — no email, role, or sensitive data | None — minimal claims |
| 13 | **Denial of Service** | Brute-force / credential stuffing on login | `app.ts`, `rate-limit.ts` | **Mitigated:** Fixed-window rate limiting ([ADR-006](adr/006-rate-limiting.md)). IP-keyed for public endpoints (5 login/300s), user-keyed for protected actions. No hard lockouts (per NIST §5.2.2). | Low – Optional: progressive delays or bot challenges |
| 14 | **Denial of Service** | Session exhaustion | `session-service.ts:171-194` | `enforceSessionLimit()` caps sessions at 3 per user via CTE + ROW_NUMBER; expired sessions cleaned before each create | An attacker with valid credentials can only hold 3 sessions |
| 15 | **Elevation of Privilege** | Missing `aud` claim in JWT | `token-service.ts:77-94` | **Gap**: No `aud` (audience) claim in tokens | If multiple services share the same secret, a token from one service could be accepted by another |
| 16 | **Elevation of Privilege** | Cross-secret token acceptance | `require-auth.ts:169-172` | Access tokens verified with `JWT_ACCESS_SECRET`, refresh tokens with `JWT_REFRESH_SECRET` — separate secrets | None — secrets are isolated per token type |
| 17 | **Spoofing** | Credential takeover via stolen session | `account-service.ts:215-262` | `changePassword()` requires current password re-verification even for authenticated users; `endAllSessionsForUser()` revokes all sessions after change ([ADR-004](adr/004-password-change-endpoint.md)) | Rate limiting depends on optional cache layer (ADR-003); without it, current password requirement + constant-time comparison are the only brute-force controls |
| 18 | **Tampering** | Race condition during password change | `account-service.ts:247-251` | Password update is a single `UPDATE ... WHERE id = ?` — SQLite serializes writes; `endAllSessionsForUser` runs after the update ensuring no session outlives the old credential | None — write serialization prevents concurrent hash corruption |

---

## JWT Pitfalls — Naive vs This Project

| Pitfall | Naive Approach | This Project | Reference |
|---------|---------------|--------------|-----------|
| **Algorithm confusion** | Accept whatever `alg` the token header says, including `"none"` | Explicit `AlgorithmTypes.HS256` parameter to `verify()` — ignores token header's `alg` claim | [`require-auth.ts:176`](../packages/core/src/auth/middleware/require-auth.ts), [RFC 8725 §2.1](https://datatracker.ietf.org/doc/html/rfc8725#section-2.1) |
| **Shared secret for all token types** | One `JWT_SECRET` for everything | Separate `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET`; `typ` claim validated in `verifyToken()` | [`require-auth.ts:169-181`](../packages/core/src/auth/middleware/require-auth.ts), [`token-service.ts:84-97`](../packages/core/src/auth/services/token-service.ts) |
| **No token type discrimination** | Accept any valid JWT in any context | `payload.typ` must match expected type (`"access"` or `"refresh"`) or request is rejected | [`require-auth.ts:179-181`](../packages/core/src/auth/middleware/require-auth.ts) |
| **Irrevocable tokens** | Stateless JWTs with no server-side check | Every token contains `sid` (session ID); `isValidSession()` checks the session exists and matches before granting access | [`require-auth.ts:59-65`](../packages/core/src/auth/middleware/require-auth.ts), [`session-service.ts:266-292`](../packages/core/src/auth/services/session-service.ts) |
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
