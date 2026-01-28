# Private Landing – Authentication Reference

> A clean, educational reference implementation of secure authentication for Cloudflare Workers

[![License](https://badgen.net/badge/License/Apache-2.0/blue?style=flat)](https://opensource.org/licenses/Apache-2.0)
[![TypeScript](https://badgen.net/badge/TypeScript/5.8+/blue?style=flat)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://badgen.net/badge/Cloudflare/Workers/orange?style=flat)](https://workers.cloudflare.com/)
[![CI](https://github.com/vhscom/private-landing/actions/workflows/ci.yml/badge.svg)](https://github.com/vhscom/private-landing/actions/workflows/ci.yml)
[![codecov](https://codecov.io/github/vhscom/private-landing/graph/badge.svg?token=24IDKH0NE1)](https://codecov.io/github/vhscom/private-landing)

**[Live Demo](https://private-landing.vhsdev.workers.dev/)**

This repository contains a **minimal, well-documented, standards-compliant authentication foundation** built for Cloudflare Workers using Hono, Turso (libSQL), PBKDF2 password hashing, JWT sessions, and secure session management.

**Important**  
This project is **primarily educational**.  
It demonstrates how to implement modern authentication correctly from first principles — following NIST SP 800-63B / SP 800-132 guidelines, OWASP recommendations, and Cloudflare Workers constraints.

For **most real-world projects** (especially if you want speed, maintainability, plugin ecosystem, OAuth/social providers, magic links, passkeys, multi-tenant support, rate limiting, etc.), you are **much better served** by using:

**Better Auth** — https://www.better-auth.com  
(the most comprehensive, framework-agnostic authentication & authorization library for TypeScript in 2025–2026)

Better Auth gives you far more features out-of-the-box, better developer experience, a growing plugin ecosystem, and active maintenance — while still letting you stay in control of your database.

Use **this repo** if you want to:
- Deeply understand how secure auth works under the hood
- Learn NIST-compliant password storage, constant-time comparison, session revocation, sliding expiration, JWT refresh patterns
- Study a clean, auditable Apache-2.0 example built specifically for edge runtimes
- Teach/experiment with auth concepts

Use **Better Auth** if you want to ship a production application quickly and reliably.

## What's Included (as a learning reference)

- NIST SP 800-132 compliant PBKDF2-SHA384 password hashing + normalization + common-password checks
- Secure session management with device tracking (user-agent + IP)
- JWT access + refresh token pattern with session linkage (for revocation)
- HTTP-only, SameSite=Strict/Lax secure cookies
- Type-safe Hono middleware (`requireAuth`)
- Turso/libSQL schema + basic migration helpers
- Zod-based input validation
- Runtime security-focused tests (format validation, tampering resistance, unicode handling, timing-safe comparison)

## What's intentionally NOT included

- OAuth / social providers (use Better Auth for that)
- Passkeys / WebAuthn
- Magic links / OTP
- Multi-factor authentication (TOTP, etc.)
- Rate limiting (implement via Cloudflare or middleware)
- Advanced session analytics / audit logs
- Multi-tenancy

These are all excellent reasons to reach for Better Auth instead.

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