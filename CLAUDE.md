# CLAUDE.md

This file provides context for AI assistants working with this codebase.

## Project Overview

Private Landing is an educational authentication reference implementation for Cloudflare Workers. It demonstrates secure authentication patterns following NIST SP 800-63B/SP 800-132 guidelines and OWASP recommendations.

**Stack:** Hono, Turso (libSQL), TypeScript, Bun, Zod

## Architecture

This is a Bun workspace monorepo:

```
apps/cloudflare-workers/    # Hono app deployed to Cloudflare Workers
packages/core/              # Auth services, middleware, crypto utilities
packages/infrastructure/    # Database client, static file serving
packages/schemas/           # Zod validation schemas
packages/types/             # Shared TypeScript types and error classes
```

### Key Design Decisions

- **JWT dual-token pattern**: Short-lived access tokens (15 min) + long-lived refresh tokens (7 days)
- **Session linkage**: Tokens contain session IDs enabling server-side revocation
- **PBKDF2-SHA384**: 100,000 iterations with 128-bit salts per NIST SP 800-132
- **Timing-safe comparison**: Uses `crypto.subtle.verify()` for constant-time equality checks
- **No composition rules**: Password policy follows NIST guidance (length only, no complexity requirements)
- **Content negotiation**: Auth endpoints return JSON when `Accept: application/json` is sent, redirects otherwise

## Commands

```bash
bun install              # Install dependencies
bun run build            # Build all packages
bun run dev              # Start dev server (port 8788)
bun run test:unit        # Run unit tests
bun run test:integration # Run integration tests (requires .dev.vars.test)
bun run test:coverage    # Run tests with coverage
bun run typecheck        # Type check all packages
bun run lint             # Lint with Biome
bun run format           # Format with Biome
```

## Testing

- Unit tests are co-located with source files (`*.test.ts`)
- Integration tests require a Turso database configured in `apps/cloudflare-workers/.dev.vars.test`
- Security-focused tests cover timing attacks, Unicode handling, and tampering resistance

## Security Considerations

When modifying authentication code:

1. **Never use string equality (`===`) for secrets** - use `timingSafeEqual` from `packages/core/src/auth/utils/crypto.ts`
2. **JWT verification requires explicit algorithm** - always use `AlgorithmTypes.HS256`
3. **Parameterize all database queries** - never concatenate user input into SQL
4. **Return generic error messages** - avoid leaking whether users exist

## Documentation

- `docs/adr/` - Architecture Decision Records explaining design choices
- `docs/audits/` - Security audit reports

## Code Style

- Biome for linting and formatting
- Strict TypeScript with no implicit any
- Prefer explicit types over inference for public APIs
