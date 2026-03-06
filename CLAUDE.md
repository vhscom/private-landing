# CLAUDE.md

This file provides context for AI assistants working with this codebase.

## Project Overview

Private Landing is an educational authentication reference implementation for Cloudflare Workers. It demonstrates secure authentication patterns following NIST SP 800-63B/SP 800-132 guidelines and OWASP recommendations.

**Stack:** Hono, Turso (libSQL), Valkey (optional), TypeScript, Bun, Zod, Go

## Architecture

This is a Bun workspace monorepo with an additional Go tool:

```
apps/cloudflare-workers/    # Hono app deployed to Cloudflare Workers
packages/core/              # Auth services, middleware, crypto utilities
packages/infrastructure/    # Database client, cache client, static file serving
packages/observability/     # Removable plugin: event capture, adaptive challenges, /ops API + WebSocket
packages/schemas/           # Zod validation schemas
packages/types/             # Shared TypeScript types and error classes
tools/cli/                  # plctl — Go TUI for the /ops API (not a Bun workspace)
```

### Key Design Decisions

- **JWT dual-token pattern**: Short-lived access tokens (15 min) + long-lived refresh tokens (7 days)
- **Session linkage**: Tokens contain session IDs enabling server-side revocation
- **PBKDF2-SHA384**: 100,000 iterations with 128-bit salts per NIST SP 800-132
- **Timing-safe comparison**: Uses `crypto.subtle.verify()` for constant-time equality checks
- **No composition rules**: Password policy follows NIST guidance (length only, no complexity requirements)
- **Content negotiation**: Auth endpoints return JSON when `Accept: application/json` is sent, redirects otherwise
- **Optional cache-backed sessions**: `CacheClient` abstraction (ADR-003) enables Valkey/Redis for session storage via `createCachedSessionService`; SQL remains the default when no cache is configured
- **Session dual-write**: `createMirroredSessionService` decorator (ADR-007) wraps cache-backed sessions with best-effort SQL writes so operational queries against the `session` table stay accurate; cache remains authoritative for auth
- **Password change with full revocation**: `POST /account/password` verifies the current password, updates the hash, and revokes all sessions via `endAllSessionsForUser` (ADR-004)
- **Semantic URL grouping**: Routes organized into `/health/*` (public probes), `/auth/*` (authentication lifecycle), `/account/*` (account management), `/ops/*` (operational surface) with explicit per-route auth middleware (ADR-005)
- **Rate limiting**: Fixed-window counters via `CacheClient` (ADR-006); IP-based keying for public routes, user-based keying for authenticated routes; degrades to no-op when cache is disabled
- **Observability plugin**: `packages/observability` (ADR-008) provides structured event emission, adaptive proof-of-work challenges on login, agent credentials, and the `/ops/*` HTTP surface; removable by deleting the package and commenting two lines in `app.ts`
- **WebSocket gateway**: `GET /ops/ws` (ADR-009) provides persistent operational connections with authenticate-once upgrade, capability negotiation, heartbeat with credential re-validation, and origin blocking for browser-initiated connections
- **Cloaking**: `/ops/*` routes return 404 when `AGENT_PROVISIONING_SECRET` is absent, making the surface invisible in default deployments

## Commands

```bash
bun install              # Install dependencies
bun run clean            # Clean all build artifacts
bun run build            # Build all packages
bun run dev              # Start dev server (zero-config local SQLite, or wrangler if .dev.vars exists)
bun run dev:local        # Force local SQLite dev server even when .dev.vars is present
bun run test:unit        # Run unit tests
bun run test:integration # Run integration tests (requires .dev.vars)
bun run test:plugins     # Run observability plugin integration tests
bun run test:coverage    # Run tests with coverage
bun run test:watch       # Run tests in watch mode
bun run typecheck        # Type check all packages
bun run lint             # Lint with Biome
bun run format           # Format with Biome
bun run cli:build        # Build plctl binary (Go)
bun run cli:start        # Run plctl
bun run cli:test         # Run Go tests for plctl
```

## Local Development

`bun run dev` works with zero configuration — no Turso account, no `.env` files. The dev entry point (`apps/cloudflare-workers/src/dev.ts`) auto-detects the environment:

- **No `.dev.vars`**: Starts a Bun server with local SQLite (auto-migrated), generated JWT secrets, and static file serving
- **`.dev.vars` present**: Delegates to wrangler for a full Workers-like environment
- **`bun run dev:local`**: Forces the local SQLite server even when `.dev.vars` exists

The local database lives at `apps/cloudflare-workers/.wrangler/state/local.db` and is excluded from git. It persists across restarts but can be deleted manually to reset state.

## Testing

- Unit tests are co-located with source files (`*.test.ts`)
- Unit tests require no external services — run with `bun run test:unit`
- Integration tests require a Turso database configured in `apps/cloudflare-workers/.dev.vars`
- Plugin integration tests (`test:plugins`) use a separate `vitest.config.plugins.ts` targeting `test/integration/plugins/**`
- Cache-backed session tests use `createMemoryCacheClient()` from `packages/infrastructure` — no external Redis/Valkey needed
- Security-focused tests cover timing attacks, Unicode handling, and tampering resistance
- Go tests for `plctl` run via `bun run cli:test` (wraps `go test ./...`)

## Security Considerations

When modifying authentication code:

1. **Never use string equality (`===`) for secrets** - use `timingSafeEqual` from `packages/core/src/auth/utils/crypto.ts`
2. **JWT verification requires explicit algorithm** - always use `AlgorithmTypes.HS256`
3. **Parameterize all database queries** - never concatenate user input into SQL
4. **Return generic error messages** - avoid leaking whether users exist
5. **Cache keys are not secrets but are sensitive** - session data stored in cache contains userId, IP, and user agent; treat the cache endpoint as a trusted internal service
6. **Agent keys use SHA-256 hashing** (not PBKDF2) - 256-bit random keys stored as SHA-256 digests in the `agent_credential` table; trust levels are `read` and `write`

## Enabling Cache-Backed Features

Cache-backed sessions (ADR-003) and rate limiting (ADR-006) are controlled by a single toggle in `apps/cloudflare-workers/src/app.ts`:

```typescript
// Default: no cache (SQL-only sessions, no rate limiting)
const createCacheClient: CacheClientFactory | null = null;

// Enable: import createValkeyClient and assign it
const createCacheClient: CacheClientFactory | null = createValkeyClient;
```

Both `createAuthSystem` and `createRateLimiter` read from this variable. Requires `CACHE_URL` (and optionally `CACHE_TOKEN`) in the Worker environment. Revert by setting back to `null`.

When cache is enabled, `createMirroredSessionService` (ADR-007) automatically wraps the cache-backed session service with best-effort SQL dual-writes.

## Enabling the Observability Plugin

The observability plugin (ADR-008/009) is wired in `apps/cloudflare-workers/src/app.ts` via `observabilityPlugin()`. It requires `AGENT_PROVISIONING_SECRET` in the Worker environment to activate the `/ops/*` surface. Optional env vars:

- `WS_ALLOWED_ORIGINS` — comma-separated origin allowlist for browser WebSocket connections (default: block all browser origins)

The first agent must be provisioned via direct `curl` against `/ops/agents` — `plctl` requires an existing agent key to start.

## Documentation

- `docs/adr/` - Architecture Decision Records explaining design choices (ADR-001 through ADR-009)
- `docs/audits/` - Security audit reports

## Code Style

- Biome for linting and formatting
- Strict TypeScript with no implicit any
- Prefer explicit types over inference for public APIs
