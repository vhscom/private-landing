# ADR-004: Password Change Endpoint

- **Status:** Accepted
- **Date:** 2026-02-15
- **Decision-makers:** @vhscom

## Context and Problem Statement

[ADR-001](001-auth-implementation.md) established PBKDF2-based password storage and hybrid JWT+Session authentication
with server-side revocation. [ADR-002](002-auth-enhancements.md) added rate limiting foundations, session activity
tracking, and security headers. [ADR-003](003-cache-layer-valkey.md) introduced an optional cache layer for session
state with TTL-based expiration and per-user session sets.

Despite these controls, the system provides no mechanism for users to change their password. The only recovery path for
a compromised credential is account re-registration — an unacceptable UX burden that violates OWASP ASVS v5.0 §6.2.2
("Verify that users can change their password") and §6.2.3 ("Verify that password change functionality requires the
user's current and new password"), and conflicts with NIST SP 800-63B §5.1.1.2, which requires verifiers to allow
subscribers to change their memorized secret. The project README explicitly lists "Password change endpoint"
as a **Critical** production next step.

How should we implement a secure password change endpoint that integrates with the existing authentication architecture?

## Decision Drivers

* **Credential self-service (OWASP ASVS v5.0 §6.2.2 / §6.2.3)** — users must be able to change credentials without re-registration; password change must require the current and new password
* **Memorized secret change (NIST SP 800-63B §5.1.1.2)** — verifiers shall provide a mechanism to change memorized secrets
* **Authenticator lifecycle (NIST SP 800-63B §6.1.2.1)** — authenticator lifecycle management requires credential rotation support
* **Compromise recovery** — a user who suspects credential theft needs self-service rotation without admin intervention
* **Session integrity (OWASP ASVS v5.0 §7.4.3)** — password change must offer termination of all active sessions to prevent continued use of stolen tokens
* **Cache consistency** — if ADR-003 caching is active, session invalidation must propagate to the cache (the
  authoritative store); during a migration period where both stores are populated, both should be invalidated
* **Educational value** — this is a reference implementation; the endpoint should demonstrate secure credential lifecycle
  patterns that developers can study and adapt

## Decision Outcome

Implement a `POST /account/password` endpoint that requires the current password, updates the stored hash, and
invalidates all active sessions for the user. Add an `endAllSessionsForUser` method to both the SQL and cache-backed
`SessionService` implementations.

The endpoint is registered at `/account/password` with explicit `requireAuth` inline middleware, following the URL
reorganization in [ADR-005](005-url-reorganization.md).

### Endpoint Specification

```
POST /account/password
Content-Type: application/json
Cookie: access_token=<JWT>; refresh_token=<JWT>

{
  "currentPassword": "existing-password",
  "newPassword": "replacement-password"
}
```

**Authentication:** Requires a valid session (enforced by `require-auth` middleware). The access token provides the
`uid` and `sid` claims needed to identify the user and current session.

**Request validation** (via Zod schema in `packages/schemas`):

- `currentPassword` — required, string, same constraints as login (8–64 characters after Unicode normalization)
- `newPassword` — required, string, must pass existing password policy (minimum length, common password check, Unicode
  normalization per ADR-001)
- `newPassword !== currentPassword` — reject no-op changes to avoid false sense of security

**Processing steps:**

1. Extract `userId` from the JWT payload (already validated by `require-auth`)
2. Fetch the stored password hash from the account table
3. Verify `currentPassword` against the stored hash using `verifyPassword` (PBKDF2 constant-time comparison)
4. If verification fails, return `400` with a generic error ("Password change failed") — do not reveal whether the
   current password was incorrect vs. another failure
5. Hash `newPassword` using `hashPassword` (PBKDF2-SHA384, 100k iterations, fresh 128-bit salt)
6. Update the password hash in the account table
7. Invoke `endAllSessionsForUser(userId)` to invalidate every active session
8. Clear the current request's auth cookies (`access_token`, `refresh_token`)
9. Return `200` with `{ message: "Password changed successfully" }` or redirect to login (per content negotiation)

**Content negotiation:** Follows the existing pattern — returns JSON when `Accept: application/json` is present,
otherwise redirects to the login page.

### Session Revocation: `endAllSessionsForUser`

Neither the SQL nor cache-backed `SessionService` currently supports bulk session revocation. A new method is required
on the `SessionService` interface:

```typescript
/**
 * Ends all active sessions for a user.
 * Used during password change to force re-authentication on all devices.
 *
 * @param userId - User whose sessions should be revoked
 * @param ctx - Auth context with environment bindings
 */
endAllSessionsForUser(userId: number, ctx: AuthContext): Promise<void>;
```

Both `SessionService` implementations must support this method. The password change feature must not depend on the
optional cache layer — the SQL-backed session service is the default path and must provide full functionality
independently.

**SQL implementation** (`session-service.ts`) — default path:

```sql
UPDATE session
SET expires_at = datetime('now')
WHERE user_id = ? AND expires_at > datetime('now')
```

This is a single atomic statement that immediately expires all active sessions for the user. No cache dependency is
required. Auth cookies are cleared on the current context afterward.

**Cache-backed implementation** (`cached-session-service.ts`) — optional path (ADR-003):

1. `SMEMBERS user_sessions:{userId}` — retrieve all session IDs for the user
2. `DEL session:{id1} session:{id2} ...` — delete each session key
3. `DEL user_sessions:{userId}` — remove the session set
4. Clear auth cookies on the current context

When ADR-003 caching is active, the cache is the authoritative session store, so only cache invalidation is needed. If
both stores are populated during a migration period (see ADR-003 § Deployment and Rollback), both should be
invalidated.

### Rate Limiting

The password change endpoint must be rate-limited aggressively to prevent online credential-guessing attacks against
the `currentPassword` field:

- **Limit:** 5 attempts per 15 minutes, scoped by `userId` (not IP alone, since the user is authenticated)
- **Failure response:** `429 Too Many Requests` with `Retry-After` header
- **Key format:** `ratelimit:password_change:{userId}`

**With cache (ADR-003 active):** Rate limiting uses `CacheClient` via `INCR` + `EXPIRE` (same pattern as ADR-002
Phase 1). This is the recommended deployment for production.

**Without cache (SQL-only default):** Rate limiting is not available on this endpoint, consistent with how all rate
limiting in ADR-002 Phase 1 depends on `CacheClient`. The endpoint remains functional — the `currentPassword`
verification requirement, constant-time comparison, and existing account lockout logic (ADR-002 Phase 2) still
constrain brute-force attempts. However, deployments handling untrusted traffic should enable the cache layer to get
proper rate limiting across all auth endpoints, not just password change.

Per-user scoping is preferred over per-IP because the attacker must already hold a valid session to reach the endpoint.
IP-based limits may be added as a secondary control if needed.

### Schema Addition

```typescript
// packages/schemas — passwordChangeSchema
// Reuses the existing passwordSchema (8–64 chars, NFKC normalization, post-normalization length checks)
const passwordChangeSchema = z.object({
  currentPassword: passwordSchema,
  newPassword: passwordSchema,
}).refine(
  (data) => data.currentPassword !== data.newPassword,
  { message: "New password must differ from current password" }
);
```

### Consequences

#### Positive

- Fulfills OWASP ASVS v5.0 §6.2.2, §6.2.3, §7.4.3 and NIST SP 800-63B §5.1.1.2 credential change requirements
- Self-service credential rotation removes dependency on admin intervention or re-registration
- Full session revocation on password change ensures stolen tokens cannot outlive a credential rotation
- Works on the default SQL-only path with no infrastructure beyond Turso; cache layer enhances rate limiting but is not
  required for correctness
- Cache invalidation via `SMEMBERS` + `DEL` is O(n) in active sessions (max 3 per ADR-001) — negligible cost when
  cache is active; SQL bulk `UPDATE` is equally efficient
- Demonstrates secure authenticator lifecycle management for educational purposes
- Extends the `SessionService` interface with `endAllSessionsForUser`, which is independently useful for admin-initiated
  revocation or future account suspension features
- Reuses existing infrastructure: `verifyPassword`, `hashPassword`, `require-auth`, Zod schemas, content negotiation,
  `CacheClient`, and cookie utilities — minimal new code surface

#### Negative

- Adds a sensitive endpoint that accepts the current password — expands the attack surface for credential capture if
  TLS is misconfigured or the endpoint is logged improperly (mitigated by existing HSTS and `no-store` cache headers
  from ADR-002)
- `endAllSessionsForUser` forces logout on all devices, which may surprise users with multiple active sessions — this
  is the correct security trade-off but impacts multi-device UX
- Password change does not trigger email notification in this implementation (scoped out to keep the reference
  implementation focused) — production deployments should add notification as a detection control
- Adds a new interface method to `SessionService`, requiring updates to both implementations and the in-memory test
  stub

## Analysis of Existing Mitigations

### What ADRs 001–003 Already Provide

The existing architecture significantly reduces the risk surface of adding a password change endpoint:

| Threat | Existing Mitigation | Sufficient? |
|---|---|---|
| Session hijacking post-change | `endAllSessionsForUser` invalidates all sessions; JWT `sid` binding means stolen tokens fail validation on next request (ADR-001) | Yes, once `endAllSessionsForUser` is implemented |
| Cache staleness after revocation | Cache-backed `endSession` already performs `DEL` + `SREM` (ADR-003); bulk variant follows same pattern | Yes |
| CSRF on password change | `SameSite=Strict` cookies prevent cross-origin submission (ADR-002 §5) | Yes |
| Credential stuffing on endpoint | Rate limiting infrastructure exists (ADR-002 Phase 1); per-user scoping on authenticated endpoint further constrains attack | Yes when cache is active; degraded without cache (current password requirement + account lockout still apply, but no atomic counter) |
| Timing side-channel on current password check | `verifyPassword` uses constant-time comparison via `crypto.subtle.verify()` (ADR-001) | Yes |
| Brute-force via stolen session cookie | Attacker must hold a valid `HttpOnly`/`Secure`/`SameSite=Strict` cookie AND know the current password — two independent factors | Yes |
| Password hash tampering | Integrity digest in stored format detects modification (ADR-001) | Yes |

### New Threats Introduced

1. **Automation via AI agents or headless browsers:** An attacker controlling a valid session (e.g., via XSS in a
   different application on the same origin, or a compromised device) could script password change attempts. Mitigation:
   requiring the current password means session-only access is insufficient. Rate limiting bounds attempt volume.

2. **Race condition during change:** Concurrent requests could read the old hash while an update is in flight.
   Mitigation: the password update is a single `UPDATE ... WHERE id = ?` — SQLite serializes writes. The
   `endAllSessionsForUser` call after the update ensures no session outlives the old credential regardless of timing.

3. **Sliding expiration interaction:** A cached session could be refreshed (TTL extended) moments before
   `endAllSessionsForUser` runs. Mitigation: `endAllSessionsForUser` performs explicit `DEL` on all session keys — TTL
   is irrelevant because the key is removed, not expired.

4. **Logging sensitive data:** Request bodies containing passwords must not be logged. Mitigation: Hono does not log
   request bodies by default. If structured logging is added later, the password change route must be excluded or
   body-redacted.

### What Is Not Needed

- **CSRF tokens:** `SameSite=Strict` is sufficient (ADR-002 §5 analysis applies identically here)
- **Email notification:** Valuable in production but out of scope for this educational reference — noted as a future
  enhancement
- **Recovery codes / backup authentication:** Password change requires the current password, not a recovery flow; these
  are orthogonal concerns for a future password reset (forgot password) feature
- **Second-factor requirement (2FA/passkey):** The system does not yet implement 2FA (noted in ADR-002 Future
  Considerations). Requiring `currentPassword` verification serves as re-authentication. When 2FA is added, the
  password change endpoint should require it as a step-up authentication for defense-in-depth

## Alternatives Considered

### Defer to Production Libraries

Delegate credential management to a production authentication library (e.g., Better Auth, Lucia, Auth.js) rather than
implementing password change from scratch.

- Good, because production libraries handle edge cases (account lockout interactions, notification hooks, audit trails)
  that a reference implementation may overlook
- Good, because it reduces the security-sensitive code surface maintained by the project
- Bad, because it undermines the project's explicit purpose as an educational from-scratch implementation
- Bad, because it introduces a dependency that obscures the patterns this project exists to teach
- Rejected because the learning value of implementing credential lifecycle management is core to the project's mission

### Password Change Without Current Password Verification

Allow authenticated users to change their password using only their valid session, without re-entering the current
password.

- Good, because it simplifies the UX (one fewer field)
- Bad, because a stolen session (e.g., via physical device access or session fixation) would grant full credential
  takeover with no additional authentication barrier
- Bad, because it violates NIST SP 800-63B §5.1.1.2, which states that the verifier shall verify the claimant's
  identity before changing the authenticator
- Rejected because the marginal UX improvement does not justify the security regression

### Selective Session Revocation (Keep Current Session)

Invalidate all sessions except the one making the password change request, allowing the user to remain logged in.

- Good, because it avoids forcing the user to re-authenticate immediately after changing their password
- Bad, because the current session's JWT was issued under the old credential — continuing to honor it creates a window
  where the security invariant (session bound to valid credential) is violated
- Bad, because it adds complexity (filter by `sid` during bulk revocation) for marginal UX benefit
- Rejected because the security-first posture of this reference implementation favors clean revocation; the user
  re-authenticates with their new password immediately

## Future Considerations

- **Email notification on password change** — detect unauthorized changes via out-of-band alert
- **Step-up authentication with 2FA/passkey** — when second factors are implemented (ADR-002 Future Considerations),
  require them during password change for defense-in-depth against session-only attackers
- **Password history enforcement** — prevent reuse of recent passwords (NIST SP 800-63B does *not* recommend this, but
  some compliance frameworks require it)
- **Admin-initiated password reset** — leverage `endAllSessionsForUser` to support forced credential rotation
- **Audit logging** — record password change events in the session activity table (ADR-002 Phase 2) for forensic review

## References

- [NIST SP 800-63B §5.1.1 — Memorized Secrets](https://pages.nist.gov/800-63-3/sp800-63b.html#memsecret)
- [NIST SP 800-63B §6.1.2 — Post-Enrollment Binding of an Authenticator](https://pages.nist.gov/800-63-3/sp800-63b.html#post-enroll-bind)
- [OWASP ASVS v5.0 §6.2 — Password Security](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x15-V6-Authentication.md#v62-password-security) (§6.2.2, §6.2.3)
- [OWASP ASVS v5.0 §7.4 — Session Termination](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x16-V7-Session-Management.md#v74-session-termination) (§7.4.3)
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [ADR-001: Authentication Implementation](001-auth-implementation.md)
- [ADR-002: Authentication Security Enhancements](002-auth-enhancements.md)
- [ADR-003: Cache Layer with Valkey](003-cache-layer-valkey.md)
