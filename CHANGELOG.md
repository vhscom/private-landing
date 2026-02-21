# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2026-02-21

### Added

- Fixed-window rate limiting middleware `createRateLimiter` backed by the `CacheClient` abstraction ([ADR-006](docs/adr/006-rate-limiting.md))
  - IP-keyed on public auth routes: 5 attempts / 300 s for login and register, 20 / 300 s for the `/auth/*` group
  - User ID-keyed on authenticated routes: 5 logouts / 300 s, 3 password changes / 3600 s
  - Degrades to a no-op pass-through when no cache is configured (`createCacheClient = null`)
  - Returns `429 Too Many Requests` with `Retry-After` header on limit breach
  - Fails open on cache errors — a cache outage does not block legitimate requests

### Fixed

- `'unsafe-eval'` removed from `Content-Security-Policy` `script-src` — not required by any code in the project
- Session limit enforcement now runs post-INSERT to correctly count the newly created session and avoid an off-by-one window where a 4th concurrent session could exist momentarily
- Unit tests added for INCR+EXPIRE partial-failure paths: `expire` failure triggers `del` cleanup; both `expire` and `del` failing still fails open

### Documentation

- ADR-006: rate limiting design and configuration record
- Security audit report covering rate limiting middleware and wizard UI (v1.3.0 stop-gap review)
- Rate limiting rejection steps added to login and register flow diagrams
- STRIDE threat model updated: brute-force gap now marked as mitigated

## [1.3.0] - 2026-02-16

### Changed

- Reorganized all routes from `/api/*` into semantic groups: `/health`, `/auth/*`, `/account/*` ([ADR-005](docs/adr/005-url-reorganization.md))
- Replaced `app.use("/api/*", requireAuth)` catch-all with explicit per-route `requireAuth` middleware
- Replaced `/api/ping` with `GET /account/me` returning `{ userId }`
- Health endpoint is now public (no auth required)
- Removed `/health/live` and `/health/ready` — single `/health` endpoint is sufficient for Workers
- Suppressed `noImportantStyles` lint rule for `prefers-reduced-motion` overrides in HTML

### Added

- Tabbed wizard UI with four steps: Register, Login, Password, Logout
- Auth status badge with click-to-check against `/account/me`
- Console stays visible during fetch with "waiting..." indicator
- No-JS progressive enhancement: native form submissions with fragment-based status banners via CSS `:target`
- `<main>` landmark for accessibility
- `<meta name="theme-color">` for dark and light modes

### Documentation

- ADR-005: URL reorganization decision record
- Updated route paths across all ADRs, flow diagrams, CLAUDE.md, and integration tests

## [1.2.0] - 2026-02-15

### Added

- Password change endpoint `POST /api/account/password` with current password re-verification ([ADR-004](docs/adr/004-password-change-endpoint.md))
- `endAllSessionsForUser` on `SessionService` interface — atomic revocation of all sessions for a user (SQL and cache-backed implementations)
- `changePassword` on `AccountService` — validates input, verifies current password with timing-safe comparison, rehashes with fresh salt
- `passwordChangeSchema` Zod schema with cross-field refinement (rejects no-op changes)
- `PasswordChangeInput` type in `@private-landing/types`
- Integration tests for password change critical path (8 tests covering success, revocation, re-login, error cases)
- Unit tests for `endAllSessionsForUser` and `changePassword` across SQL and cache-backed services

### Documentation

- ADR-004: password change endpoint decision record with OWASP ASVS v5.0 and NIST SP 800-63B references
- Updated auth flow diagrams with password change sequence
- Added password change threats to STRIDE threat model
- Updated OWASP ASVS references from v4.0 to v5.0 in threat model
- Updated README: moved password change from production next steps to implemented features, added to feature table
- CLAUDE.md: added password change to key design decisions, added cache enablement shortcut
- Security audit report for ADR-004 password change implementation

## [1.1.0] - 2026-02-15

### Added

- Optional cache-backed session service via `createCachedSessionService` ([ADR-003](docs/adr/003-cache-layer-valkey.md))
- Valkey/Redis cache client abstraction with in-memory test implementation
- Worker cache bindings in wrangler configuration
- Cache layer security audit report
- RFC 9116 `security.txt`
- `robots.txt` to guide crawlers on usage
- Per-suite user isolation for integration tests

### Fixed

- Password verification now uses constant-time combine for digest comparison
- Email max length enforcement in validation schema
- Password max length enforcement post-normalization
- Auth middleware returns 500 for non-auth errors instead of leaking context
- Session `expiresAt` drift on sliding window renewal
- Memory cache client `del` count logic
- Default SQL session fallback when no cache is configured

### Changed

- Exposed Hono JWT error types for downstream consumers
- Integration tests no longer require `--retry 3`
- Removed CI-only concurrency special-casing in vitest config

### Documentation

- ADR-003: cache layer decision record (accepted), deployment/rollback plan, TCP availability clarification
- Updated cross-references, contributing guide, and CLAUDE.md for cache onboarding

## [1.0.0] - 2026-02-09

### Added

- NIST-aligned password handling using PBKDF2-SHA384 with 100,000 iterations
- JWT dual-token pattern: access tokens (15 min) + refresh tokens (7 days)
- Device-aware sessions with IP tracking, sliding expiration, and revocation
- SQLite reference schema optimized for Turso with migrations and management tooling
- Edge-first architecture built for Cloudflare Workers using Hono
- CSRF protection patterns, secure cookie handling, and rate-limiting hooks
- Monorepo structure with workspace packages:
  - `@private-landing/core`
  - `@private-landing/infrastructure`
  - `@private-landing/schemas`
  - `@private-landing/types`
  - `@private-landing/cloudflare-workers`
- Full TypeScript coverage with strict mode
- Integration and unit test suites with security-focused test cases
- Architecture Decision Records in `docs/adr/`
- Security audit reports in `docs/audits/`

[1.4.0]: https://github.com/vhscom/private-landing/compare/1.3.0...1.4.0
[1.3.0]: https://github.com/vhscom/private-landing/compare/1.2.0...1.3.0
[1.2.0]: https://github.com/vhscom/private-landing/compare/1.1.0...1.2.0
[1.1.0]: https://github.com/vhscom/private-landing/compare/1.0.0...1.1.0
[1.0.0]: https://github.com/vhscom/private-landing/commits/1.0.0
