# ADR-002: Authentication Security Enhancements

## Status

Draft

## Context

[ADR-001](001-auth-implementation.md) established our core authentication system with JWT + session-based hybrid
authentication. As we move towards production, we need to enhance security against common attack vectors while
maintaining the system's performance characteristics for our ~100 user target.

## Decision

We will implement security enhancements in three phases, prioritized by security impact vs. implementation complexity.

### Phase 1: Critical Security Controls

#### 1. Input Validation & Type Safety ✅

Implements controls against CWE-20: Improper Input Validation.

Implemented:

- Schema-based validation with Zod
- Runtime type checking via discriminated unions
- Unicode and space normalization for passwords
- Common password detection
- Email format verification
- Type-safe error handling

```ts
// Example of implemented validation
const loginSchema = z.object({
  email: emailSchema,
  password: z.string().transform(normalizePassword),
});

// Type-safe authentication flow
const isAuthenticated = (result: AuthResult): result is AuthenticatedState => 
  result.authenticated;
```

#### 2. Rate Limiting

```typescript
interface RateLimitConfig {
    windowSeconds: number;
    maxAttempts: number;
    keyPrefix: string;
}

const defaultLimits = {
    login: {windowSeconds: 300, maxAttempts: 5},     // 5 attempts per 5 min
    refresh: {windowSeconds: 3600, maxAttempts: 10}, // 10 attempts per hour
    reset: {windowSeconds: 3600, maxAttempts: 3}     // 3 attempts per hour
};
```

Implementation:

- Use Cloudflare KV for rate limit counters
- Scope limits by IP + action type
- Auto-expiring KV entries match window size
- Minimal impact on successful auth flows

#### 3. Token Rotation

Enhance refresh token security by implementing one-time use:

```sql
-- Add to existing session table
ALTER TABLE session
    ADD COLUMN
        last_token_rotation TIMESTAMP;

-- Track rotated tokens
CREATE TABLE token_rotation
(
    old_token_id TEXT PRIMARY KEY,
    new_token_id TEXT      NOT NULL,
    rotated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at   TIMESTAMP NOT NULL
);
```

### Phase 2: Visibility & Control

#### 3. Session Activity Tracking

Extend existing session management:

```sql
-- Add to existing schema from ADR-001
CREATE TABLE session_activity
(
    id         INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    action     TEXT NOT NULL,
    ip_address TEXT NOT NULL,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES session (id)
);

-- Index for efficient queries
CREATE INDEX idx_session_activity_time
    ON session_activity (session_id, created_at);
```

Track key events:

- Login attempts (success/failure)
- Token refreshes
- Password changes
- Unusual IP changes
- Session terminations

#### 4. Account Lockout

Build on rate limiting infrastructure:

```typescript
interface LockoutConfig {
    maxFailedAttempts: number;      // Default: 10
    lockoutDurationMinutes: number; // Default: 30
    failureWindowHours: number;     // Default: 24
}
```

### Phase 3: Additional Protections

#### 5. CSRF Protection

For non-GET endpoints not using Authorization header:

```typescript
const csrfConfig = {
    tokenLength: 32,
    cookieName: '__Host-csrf',
    headerName: 'X-CSRF-Token'
};
```

#### 6. Concurrent Session Management

Enhance existing session limits:

```sql
-- Add to session table
ALTER TABLE session
    ADD COLUMN
        last_active TIMESTAMP;

-- Add session metadata
ALTER TABLE session
    ADD COLUMN
        device_type TEXT,
  device_name TEXT;
```

#### 7. Security Headers

Following OWASP Secure Headers Project recommendations:

```typescript
const securityHeaders = {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Frame-Options": "deny",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "upgrade-insecure-requests",
        "block-all-mixed-content"
    ].join("; "),
    "X-Permitted-Cross-Domain-Policies": "none",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store, max-age=0"
};
```

## Technical Impact

### Storage Requirements

- KV Usage: ~1KB per active rate limit window
- DB Growth: ~100 bytes per session activity record
- Estimated monthly growth: < 50MB for 100 users

### Performance Impact

- Rate Limiting: +5-10ms per auth request
- Token Rotation: +1 DB query per refresh
- Activity Tracking: +1 async DB write per event
- Maximum added latency: ~20ms worst case

## Migration Plan

1. Deploy Schema Updates
   ```sql
   BEGIN TRANSACTION;
     -- Add new columns
     -- Create new tables
     -- Add indices
   COMMIT;
   ```

2. Code Deployment Sequence
    - Deploy rate limiting
    - Enable token rotation
    - Add activity tracking
    - Roll out remaining features

## Monitoring & Maintenance

### Key Metrics

- Auth failure rates
- Token refresh patterns
- Session duration statistics
- Lock-out frequency
- Storage growth rates

### Maintenance Tasks

- Prune expired rate limit entries (daily)
- Archive session activity > 90 days
- Clean up rotated token records
- Alert on unusual patterns

## Alternatives Considered

### Valkey vs KV for Rate Limiting

- Pros of Valkey:
    - Redis-compatible API
    - Built-in TTL and atomic operations
    - Edge deployment ready
    - No cold starts
    - Lower latency than KV (~5ms vs ~30ms)
    - More flexible data structures
- Cons of Valkey:
    - Additional Cloudflare Worker binding required
    - Potentially higher cost at scale
    - Memory limits per instance
- Pros of KV:
    - Already available in our stack
    - Globally consistent
    - No memory limits
    - Simpler deployment
- Decision: Start with KV for MVP, design for easy migration to Valkey if performance becomes critical

### JWT Blacklist vs Token Rotation

- Pros of blacklist: Simpler implementation
- Cons: Growing storage, slower validation
- Decision: Use rotation for better scalability

## Future Considerations

- SSO integration preparation
- Hardware 2FA support
- Biometric authentication hooks
- Geo-fencing capabilities
- Advanced analytics

## References

- [OWASP ASVS 4.0 Level 2](https://owasp.org/www-project-application-security-verification-standard/)
- [RFC 6819 - OAuth 2.0 Threat Model](https://tools.ietf.org/html/rfc6819)
- [Token Best Practices - Auth0](https://auth0.com/docs/secure/tokens/token-best-practices)
- [NIST SP 800-63B - Digital Identity Guidelines (Authentication & Lifecycle)](https://pages.nist.gov/800-63-3/sp800-63b.html)
- [Unicode Standard Annex #15 - Unicode Normalization Forms](https://www.unicode.org/reports/tr15/)
- [CWE-20: Improper Input Validation](https://cwe.mitre.org/data/definitions/20.html)