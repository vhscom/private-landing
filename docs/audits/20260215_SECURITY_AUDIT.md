# Security Audit Report - Password Change Endpoint

**Project:** Cloudflare Workers Authentication Foundation  
**Date:** February 15, 2026  
**Audit Type:** Feature Security Review (ADR-004 Password Change Endpoint)  
**Auditor:** Claude Opus 4.6  
**Status:** PASSED - NO ACTIONABLE VULNERABILITIES FOUND

---

## Executive Summary

This audit reviews the password change endpoint introduced in ADR-004, which adds `POST /api/account/password` with current password re-verification, PBKDF2 rehashing, and full session revocation. The review covers all new and modified files across `packages/schemas`, `packages/types`, `packages/core`, and `apps/cloudflare-workers`.

**Overall Security Rating:** EXCELLENT

### Scope

Files reviewed:
- `packages/schemas/src/auth/credentials.ts` — `passwordChangeSchema` with cross-field refinement
- `packages/types/src/auth/authentication.ts` — `PasswordChangeInput` interface
- `packages/core/src/auth/services/account-service.ts` — `changePassword` method (lines 215–268)
- `packages/core/src/auth/services/session-service.ts` — `endAllSessionsForUser` SQL implementation (lines 312–327)
- `packages/core/src/auth/services/cached-session-service.ts` — `endAllSessionsForUser` cache implementation (lines 168–183)
- `apps/cloudflare-workers/src/app.ts` — Route handler (lines 107–145)

---

## Security Analysis

### 1. Authentication & Re-verification

**Current password required (account-service.ts:249–252)**
The `changePassword` method verifies the current password against the stored hash before permitting any change. This prevents session-only attackers (e.g., physical device access) from escalating to credential takeover. Satisfies OWASP ASVS v5.0 §6.2.3 and NIST SP 800-63B §5.1.1.2.

**Route protected by `requireAuth` middleware (app.ts:107)**
The endpoint requires a valid JWT session before reaching the handler. The `requireAuth` middleware validates the access token, checks session linkage, and handles refresh — no bypass path exists.

### 2. Timing-Safe Rejection

**Non-existent user path (account-service.ts:237–242)**
When `userId` yields zero rows, `rejectPasswordWithConstantTime` runs a full PBKDF2 derivation against a dummy hash before throwing. This equalizes response time with the valid-user path, preventing timing-based information disclosure about account existence.

**Incorrect password path (account-service.ts:249–256)**
Uses `passwords.verifyPassword` which performs constant-time comparison via `crypto.subtle.verify()`. The error message (`"Password change failed"`) is identical to the non-existent user case.

### 3. Input Validation

**Zod schema with cross-field refinement (credentials.ts:72–80)**
Both `currentPassword` and `newPassword` pass through the existing `passwordSchema` (8–64 chars, NFKC normalization, post-normalization length checks). A `.refine()` rejects no-op changes where `currentPassword === newPassword`. The refinement runs after normalization, so Unicode-equivalent passwords that normalize to the same string are correctly rejected.

**Parameterized queries (account-service.ts:230–234, 262–267)**
Both the SELECT and UPDATE use parameterized `args` arrays. No string concatenation of user input into SQL.

### 4. Cryptographic Operations

**Fresh salt on rehash (account-service.ts:258–260)**
`hashPassword` generates a new 128-bit random salt for each password change. The old salt is never reused. This follows NIST SP 800-132 guidance.

**Same PBKDF2 parameters as registration**
The rehash uses identical parameters (SHA-384, 100,000 iterations, 128-bit salt) as initial registration. No downgrade path exists.

### 5. Session Revocation

**SQL path — atomic bulk expiration (session-service.ts:317–323)**
A single `UPDATE ... SET expires_at = datetime('now') WHERE user_id = ? AND expires_at > datetime('now')` expires all active sessions atomically. SQLite serializes writes, preventing race conditions where a concurrent request could read the old hash while the update is in flight.

**Cache path — explicit key deletion (cached-session-service.ts:172–180)**
`SMEMBERS user_sessions:{userId}` retrieves all session IDs, then each `session:{id}` key is deleted individually, followed by the set itself. TTL is irrelevant because keys are explicitly removed. No stale session can survive.

**Cookie clearing (session-service.ts:325–326, cached-session-service.ts:182–183)**
Both implementations clear `access_token` and `refresh_token` cookies on the current context after revoking sessions. The user is immediately logged out.

**All sessions revoked, including current (app.ts:119)**
The handler calls `endAllSessionsForUser` without filtering the current session. This is the correct security trade-off — the JWT was issued under the old credential and should not be honored after a password change.

### 6. Error Handling & Information Disclosure

**Generic error messages (app.ts:128–144)**
The catch block returns `"Password change failed"` for all non-ValidationError exceptions. ValidationError messages from the Zod schema (e.g., "Password must contain at least 8 characters") are propagated but do not reveal account state. The `PASSWORD_CHANGE_ERROR` code is generic.

**`console.error` for server-side debugging (app.ts:129)**
The error is logged server-side for debugging. Hono does not log request bodies by default, so the current and new passwords are not captured in logs.

**Content negotiation (app.ts:108, 121–127)**
Follows the existing pattern — JSON when `Accept: application/json`, redirect otherwise. No new information disclosure vector.

### 7. CSRF Protection

**SameSite=Strict cookies**
The endpoint is protected by the same `SameSite=Strict` cookie attribute as all other auth endpoints. Cross-origin form submissions cannot attach the auth cookies. No CSRF token is needed (consistent with ADR-002 §5 analysis).

---

## Findings

No vulnerabilities meeting the HIGH or MEDIUM confidence threshold (>80%) were identified. Five potential concerns were evaluated and all scored below confidence 3/10:

| # | Category | Finding | Confidence | Disposition |
|---|----------|---------|------------|-------------|
| 1 | Timing | Different error paths for missing user vs wrong password | 2/10 | False positive — `rejectPasswordWithConstantTime` equalizes timing; error messages are identical |
| 2 | Auth | No rate limiting on password change endpoint | 2/10 | Acknowledged in ADR-004 — current password requirement + constant-time comparison constrain brute-force; cache-backed rate limiting available when ADR-003 is active |
| 3 | Session | Race between password update and session revocation | 2/10 | False positive — SQLite serializes writes; `endAllSessionsForUser` runs after successful UPDATE; no window for old-credential sessions |
| 4 | Input | Schema refinement compares post-normalization strings | 1/10 | False positive — this is correct behavior; pre-normalization comparison could allow visually identical but byte-different passwords to bypass the check |
| 5 | Data | `console.error` could log password if error object contains it | 1/10 | False positive — the error is a `ValidationError` or generic `Error` with a message string; the password values are not included in the error object |

---

## Comparison with Previous Audits

The password change implementation maintains all security properties established in prior audits:

- Timing-safe password comparison via `crypto.subtle.verify()` (audit Jan 19, 2026) — extended to password change verification
- Parameterized database queries (audit Jan 17, 2026) — both SELECT and UPDATE use `args` arrays
- HTTP-only, Secure, SameSite=Strict cookie attributes (unchanged) — cookies cleared on password change
- Session-JWT linkage enabling server-side revocation (audit Feb 14, 2026) — extended with `endAllSessionsForUser` for bulk revocation
- Cache key construction using server-generated values only (audit Feb 14, 2026) — `endAllSessionsForUser` cache path follows same pattern

No regressions identified.

---

## Recommendations

No mandatory changes required. Optional hardening for future consideration:

1. **Email notification on password change** — detect unauthorized changes via out-of-band alert (noted in ADR-004 Future Considerations)
2. **Rate limiting when cache is active** — ADR-004 specifies 5 attempts per 15 minutes scoped by userId; implement when rate limiting infrastructure is built out
3. **Audit logging** — record password change events for forensic review (noted in threat model row 9)

---

## Verification

```bash
bun run build        # Clean build
bun run typecheck    # No type errors
bun run lint         # No lint violations
bun run test:unit    # 315 tests passing
bun run test:integration  # 63 tests passing
```

All checks passed at time of audit.
