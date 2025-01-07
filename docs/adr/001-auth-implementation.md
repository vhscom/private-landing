# ADR-001: Authentication Implementation

## Status

Accepted

## Context

We need to implement a secure authentication system for our web application targeting ~100 users. While we have no specific compliance requirements, the system should follow security best practices and provide a good user experience. This aligns with typical early-stage startup needs.

## Decision

### Password Storage

- Using PBKDF2 with SHA-384 for password hashing
- 100,000 iterations for key stretching
- 128-bit (16 byte) random salt per NIST SP 800-132
- Additional integrity digest using SHA-384
- Version tracking for future algorithm upgrades
- Storage format: `$pbkdf2-shaXXX$v1$iterations$salt$hash$digest`

### Session Management

- Session IDs generated using nanoid
  - 21 characters (vs 36 for UUID)
  - URL-safe by default
  - Better distribution for database indexes
  - ~121 bits of randomness (sufficient for session IDs)
  - Efficient cookie storage
  - Fast generation
- HTTP-only, secure, Host-only cookies (no Domain attribute) with strict same-site policy
- Server-side session storage in SQLite database
- Signed cookies using HMAC SHA-256
- Sliding expiration with 7-day default timeout
- IP address and user agent tracking
- Session limits per user (default: 3)
- Automatic cleanup of expired sessions

### Security Features

- Constant-time comparisons for password verification
- NIST SP 800-63-3 compliant password requirements
- Protection against timing attacks
- Secure cookie attributes (httpOnly, secure, sameSite)
- Database-backed session validation
- Automatic session pruning
- Rate limiting ready

## Consequences

### Positive

- Strong security following industry standards
- Future-proof with version tracking
- Clean separation of concerns
- Maintainable codebase
- Type-safe implementation
- Easy to upgrade security parameters

### Negative

- More complex than simple password hashing
- Additional database storage requirements
- Slightly higher computational overhead

## Notes

- OWASP guidelines recommend 210,000 iterations
- Cloudflare limits us to 100,000 iterations
- Password format designed for upgradability
- Digest may be used to prevent tampering
- Session management considers scalability
- All security parameters are configurable
- Implementation follows NIST guidelines

## Alternatives Considered

### Bcrypt

- Pros:
  - Well-established and battle-tested
  - Adaptive work factor
  - Built-in salt generation
  - Memory-hard function making hardware acceleration difficult
- Cons:
  - Fixed output size (60 characters)
  - Less flexible than PBKDF2
  - Limited to 72 bytes of password data
  - No version tracking built into format

### Argon2

- Pros:
  - Winner of the Password Hashing Competition
  - Memory-hard and highly resistant to GPU attacks
  - Configurable memory, parallelism, and iterations
  - Modern algorithm with strong security properties
- Cons:
  - Relatively newer compared to PBKDF2 and Bcrypt
  - Less widespread library support
  - More complex implementation
  - Higher system requirements for memory usage

We chose PBKDF2 because:

- Widespread support across languages and platforms
- FIPS-140 compliance if needed in future
- Simpler implementation while still meeting security requirements
- Flexibility in hash function selection
- Easy to adjust iterations as computational power increases
- Built-in support in many cryptographic libraries

## References

- [IETF RFC 2898 §5.2](https://datatracker.ietf.org/doc/html/rfc2898#section-5.2)
- [IETF RFC 9106](https://datatracker.ietf.org/doc/rfc9106/) (informational)
- [NIST SP 800-132](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-132.pdf)
- [NIST SP 800-63-3](https://pages.nist.gov/800-63-3/)
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [Cookie Security: SameSite FAQ](https://web.dev/samesite-cookies-explained/)