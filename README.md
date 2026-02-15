<div align="center">

# Private Landing

**Learn authentication by building it right.**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue?style=for-the-badge)](https://opensource.org/licenses/Apache-2.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8+-3178c6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-f38020?style=for-the-badge&logo=cloudflareworkers&logoColor=white)](https://workers.cloudflare.com/)
<br>
[![CI](https://img.shields.io/github/actions/workflow/status/vhscom/private-landing/ci.yml?style=for-the-badge&label=CI)](https://github.com/vhscom/private-landing/actions/workflows/ci.yml)
[![codecov](https://img.shields.io/codecov/c/github/vhscom/private-landing?style=for-the-badge&token=24IDKH0NE1)](https://codecov.io/github/vhscom/private-landing)

**[Live Demo](https://private-landing.vhsdev.workers.dev/)** · **[Threat Model](docs/threat-model.md)** · **[Auth Flows](docs/flows.md)** · **[ADRs](docs/adr/)**

</div>

---

A from-scratch authentication reference implementation for Cloudflare Workers — PBKDF2 password hashing, JWT dual-token sessions, constant-time comparison, and sliding expiration — all wired together with Hono, Turso (with optional Valkey/Redis caching), and strict TypeScript.

Every design choice traces back to a standard: [NIST SP 800-63B](https://pages.nist.gov/800-63-3/sp800-63b.html) for credentials, [NIST SP 800-132](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-132.pdf) for key derivation, [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/) for verification, and [RFC 8725](https://datatracker.ietf.org/doc/html/rfc8725) for JWT best practices.

> **Shipping a product?** Use **[Better Auth](https://www.better-auth.com)** instead — it covers OAuth, passkeys, MFA, rate limiting, and more out of the box with an active plugin ecosystem. This repo exists to teach you *how* auth works, not to replace a production library.

### Why this repo

- **Read the code, not just the docs** — every security property (timing-safe rejection, session-linked revocation, algorithm pinning) is implemented and tested, not just described
- **NIST + OWASP + RFC references** throughout — learn the *why* behind each decision
- **370+ tests** including attack-vector suites (token tampering, algorithm confusion, unicode edge cases)
- **Built for the edge** — runs on Cloudflare Workers with Web Crypto API, no Node.js dependencies
- **Apache-2.0** — fork it, teach with it, learn from it

## What You'll Find Inside

| Layer | What it does |
|-------|-------------|
| **Password storage** | PBKDF2-SHA384 with 128-bit salts, integrity digest, version tracking ([`password-service.ts`](packages/core/src/auth/services/password-service.ts)) |
| **Session management** | Server-side sessions with device tracking, sliding expiration, max-3-per-user enforcement; optional cache-backed sessions via Valkey/Redis ([`session-service.ts`](packages/core/src/auth/services/session-service.ts), [`cached-session-service.ts`](packages/core/src/auth/services/cached-session-service.ts)) |
| **Password change** | Current-password re-verification, full PBKDF2 rehash, atomic revocation of all sessions ([`account-service.ts`](packages/core/src/auth/services/account-service.ts), [ADR-004](docs/adr/004-password-change-endpoint.md)) |
| **JWT dual-token pattern** | 15-min access + 7-day refresh tokens, session-linked for revocation ([`token-service.ts`](packages/core/src/auth/services/token-service.ts)) |
| **Auth middleware** | Automatic refresh flow, explicit HS256 pinning, `typ` claim validation ([`require-auth.ts`](packages/core/src/auth/middleware/require-auth.ts)) |
| **Secure cookies** | HttpOnly, Secure, SameSite=Strict, Path=/ ([`cookie.ts`](packages/core/src/auth/utils/cookie.ts)) |
| **Security headers** | HSTS, CSP, CORP/COEP/COOP, Permissions-Policy, fingerprint removal ([`security.ts`](packages/core/src/auth/middleware/security.ts)) |
| **Input validation** | Zod schemas with NIST-compliant password policy (length only, no complexity rules) |
| **Attack-vector tests** | JWT tampering, algorithm confusion, type confusion, unicode edge cases, info-disclosure checks |

## Production Next Steps

This project intentionally omits features that are outside its educational scope. If you're extending this code toward production (or evaluating what a production auth system requires), the tables below organize the gaps by priority tier.

> For most real-world projects, use [Better Auth](https://www.better-auth.com) instead of building these yourself.

### Critical — Add Before Real Users

| Feature | Why It Matters | Standard / Reference |
|---------|---------------|---------------------|
| Rate limiting | Prevents brute-force login and credential-stuffing attacks — the cache layer ([ADR-003](docs/adr/003-cache-layer-valkey.md)) is available as a foundation | [OWASP ASVS v5.0 §6.3.1](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x15-V6-Authentication.md#v63-authentication-lifecycle) |
| Account lockout / throttling | Slows automated attacks without full rate-limiting infra | [NIST SP 800-63B §5.2.2](https://pages.nist.gov/800-63-3/sp800-63b.html) |
| Breached-password checking | Prevents use of passwords known to be in public breach dumps | [NIST SP 800-63B §5.1.1.2](https://pages.nist.gov/800-63-3/sp800-63b.html), [HIBP API](https://haveibeenpwned.com/API/v3) |

### High Priority — Production Confidence

| Feature | Why It Matters | Standard / Reference |
|---------|---------------|---------------------|
| CSRF protection (if SameSite relaxed) | SameSite=Strict currently prevents CSRF; if changed to Lax for UX, an explicit token is needed | [OWASP CSRF Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) |
| Refresh token rotation | Detects token theft — if a rotated-out refresh token is replayed, revoke the entire session family | [RFC 6819 §5.2.2.3](https://datatracker.ietf.org/doc/html/rfc6819#section-5.2.2.3) |
| `aud` claim in JWTs | Prevents token from one service being accepted by another sharing the same secret | [RFC 7519 §4.1.3](https://datatracker.ietf.org/doc/html/rfc7519#section-4.1.3), [RFC 8725 §3.9](https://datatracker.ietf.org/doc/html/rfc8725#section-3.9) |
| Audit logging | Enables incident response, anomaly detection, and compliance | [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html) |
| CSP nonces for inline scripts | Current CSP uses `'unsafe-inline'`; nonces eliminate inline-script XSS vectors | [MDN CSP script-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/script-src) |

### Medium Priority — As Product Scales

| Feature | Why It Matters | Standard / Reference |
|---------|---------------|---------------------|
| TOTP multi-factor auth | Adds a second factor for high-value accounts | [RFC 6238](https://datatracker.ietf.org/doc/html/rfc6238), [NIST SP 800-63B §5.1.4](https://pages.nist.gov/800-63-3/sp800-63b.html) |
| WebAuthn / passkeys | Phishing-resistant authentication using platform authenticators | [WebAuthn Level 2](https://www.w3.org/TR/webauthn-2/) |
| OAuth / social login | Reduces friction, avoids password fatigue | [RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749) |
| Magic links / OTP | Passwordless option for low-risk flows | [NIST SP 800-63B §5.1.3](https://pages.nist.gov/800-63-3/sp800-63b.html) |
| Session analytics | Device tracking, concurrent-session visibility, anomaly detection | [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) |
| Signing key rotation | Allows periodic secret rotation without invalidating all sessions | [RFC 7517 (JWK)](https://datatracker.ietf.org/doc/html/rfc7517) |

### Advanced — Enterprise / High-Security

| Feature | Why It Matters | Standard / Reference |
|---------|---------------|---------------------|
| DPoP / token binding | Binds tokens to the client's TLS connection, preventing exfiltration replay | [RFC 9449 (DPoP)](https://datatracker.ietf.org/doc/html/rfc9449) |
| Multi-tenancy | Isolates user pools, secrets, and policies per tenant | Application-specific |
| Geo-fencing / IP reputation | Blocks logins from unexpected regions or known-bad IPs | [OWASP ASVS v5.0 §6.3.5](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x15-V6-Authentication.md#v63-authentication-lifecycle) |
| Adaptive authentication | Steps up auth requirements based on risk signals (device, location, behavior) | [NIST SP 800-63B §6](https://pages.nist.gov/800-63-3/sp800-63b.html) |
| PBKDF2 iteration upgrade or Argon2id | OWASP recommends 210,000 PBKDF2-SHA512 iterations (Cloudflare limits to 100k); Argon2id is memory-hard | [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) |

All of these are excellent reasons to reach for [Better Auth](https://www.better-auth.com) instead.

## Repository Structure

```text
.
├── apps/
│   └── cloudflare-workers/    # Example Worker + Hono routes
├── packages/
│   ├── core/                  # Auth services, middleware, crypto utilities
│   ├── infrastructure/        # DB client + utilities
│   ├── schemas/               # Zod schemas
│   └── types/                 # Shared TypeScript types
└── docs/
    ├── adr/                   # Architecture Decision Records
    └── audits/                # Security audits
```

## Getting Started

```bash
# Clone and install
git clone https://github.com/vhscom/private-landing.git
cd private-landing
bun install

# Build packages
bun run build

# Start dev server
bun run dev
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed setup and testing instructions.

## Using with AI

This repository includes a [`CLAUDE.md`](CLAUDE.md) file that provides context for AI assistants. When using Claude Code, Cursor, or similar AI-powered development tools:

1. The AI will automatically read `CLAUDE.md` for project context
2. Architecture Decision Records in `docs/adr/` explain design choices
3. Security audits in `docs/audits/` document the security posture
4. Tests demonstrate expected behavior and edge cases

The codebase is designed to be AI-readable with clear module boundaries, comprehensive types, and descriptive naming.

## License

[Apache-2.0](LICENSE)