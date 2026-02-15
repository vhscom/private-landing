# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.2.0]: https://github.com/vhscom/private-landing/compare/1.1.0...1.2.0
[1.1.0]: https://github.com/vhscom/private-landing/compare/1.0.0...1.1.0
[1.0.0]: https://github.com/vhscom/private-landing/commits/1.0.0
