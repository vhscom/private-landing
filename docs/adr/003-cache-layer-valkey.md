# ADR-003: Cache Layer with Valkey for Session and Ephemeral State

- **Status:** Accepted
- **Date:** 2026-02-14
- **Decision-makers:** @vhscom

## Context and Problem Statement

[ADR-001](001-auth-implementation.md) established hybrid JWT+Session authentication with server-side session validation.
[ADR-002](002-auth-enhancements.md) identified the need for rate limiting, token rotation, and session activity tracking,
deferring the choice between Cloudflare KV and Valkey.

Every protected endpoint currently performs two SQL round-trips to Turso: an UPDATE for sliding expiration and a SELECT
to return the session ([session-service.ts](../../packages/core/src/auth/services/session-service.ts)). This is
the cost of server-side revocation — the JWT `sid` claim alone cannot confirm a session hasn't been invalidated.

Additionally, the `enforceSessionLimit` function uses a `ROW_NUMBER() OVER (PARTITION BY ...)` window query and
`cleanupExpiredSessions` runs a bulk DELETE on every `createSession` call. These are relational operations applied to
ephemeral data with known lifetimes — a poor fit for a SQL database.

How should we introduce a cache layer for ephemeral state while preserving infrastructure portability?

## Decision Drivers

* **Portability** — the application uses a libSQL endpoint specifically to avoid lock-in; the cache layer must not
  introduce vendor coupling (e.g., Cloudflare KV, Durable Objects)
* **Latency** — protected endpoint response time is directly affected by session validation round-trips
* **Operational simplicity** — expired session cleanup and rate limit counter pruning should not require scheduled jobs
  or application-level maintenance
* **Architectural fit** — the existing `SessionService` interface and `packages/infrastructure` boundary should absorb
  the change without requiring modifications to `require-auth.ts` or route handlers
* **Feature enablement** — [ADR-002](002-auth-enhancements.md) Phase 1 (rate limiting) and Phase 2 (session activity)
  need a fast ephemeral store

## Considered Options

* Valkey via `CacheClient` abstraction in `packages/infrastructure`
* Cloudflare KV
* In-memory cache (per-isolate `Map`)

## Decision Outcome

Chosen option: "Valkey via `CacheClient` abstraction", because it is the only option that satisfies both the portability
constraint and the latency/feature requirements. Valkey speaks the Redis protocol, which is supported by every major
cloud provider and can be self-hosted. The abstraction layer in `packages/infrastructure` ensures the application never
depends on Valkey directly — only on the `CacheClient` interface.

### Consequences

* Good, because session validation drops from 2 SQL round-trips to 1 GET + 1 SET (~5–10ms vs ~20–40ms)
* Good, because TTL-based expiration eliminates `cleanupExpiredSessions` entirely
* Good, because rate limiting ([ADR-002](002-auth-enhancements.md) Phase 1) becomes a single atomic INCR + EXPIRE
* Good, because session limiting per user replaces the window query with SADD/SCARD on a set
* Good, because the `CacheClient` interface can be backed by Valkey, Redis, Dragonfly, KeyDB, Upstash, or an in-memory
  stub for testing
* Good, because `require-auth.ts` and route handlers require no changes — the `SessionService` interface is unchanged
* Bad, because it introduces an additional infrastructure dependency (a Valkey-compatible server)
* Bad, because session data is no longer durable — a cache flush loses active sessions (users must re-authenticate)

### Confirmation

* Unit tests use an in-memory `CacheClient` implementation to validate session lifecycle without external dependencies
* Integration tests verify the Valkey-backed implementation against a real instance
* The `SessionService` interface contract is verified by running the existing test suite against the new implementation
* `require-auth.ts` tests pass without modification, confirming the abstraction holds

## Pros and Cons of the Options

### Valkey via `CacheClient` Abstraction

Introduce a `CacheClient` interface in `packages/infrastructure` with a Valkey implementation. Sessions, rate limit
counters, and nonces are stored as key-value pairs with TTLs. The interface exposes only the commands needed: `get`,
`set`, `del`, `incr`, `expire`, `sadd`, `srem`, `scard`, `smembers`.

* Good, because Redis protocol is a universal standard — portable across providers and self-hosted deployments
* Good, because TTL is native to the data model — no cleanup queries, no maintenance windows
* Good, because atomic operations (INCR, SADD/SCARD) map directly to rate limiting and session limiting
* Good, because the `CacheClient` interface decouples core from any specific client library
* Good, because Valkey is open-source (BSD-3-Clause) with no licensing concerns
* Neutral, because edge-runtime compatibility requires an HTTP-based client (e.g., Upstash REST) rather than TCP
* Bad, because it adds an infrastructure dependency beyond libSQL

### Cloudflare KV

Use Cloudflare Workers KV for session storage and rate limit counters, as originally considered in
[ADR-002](002-auth-enhancements.md).

* Good, because it is already available in the Cloudflare Workers runtime with no additional setup
* Good, because it is globally distributed with strong eventual consistency
* Good, because TTL is supported natively
* Bad, because it creates direct coupling to Cloudflare infrastructure — contradicts the portability decision behind
  choosing libSQL
* Bad, because KV is eventually consistent (~60s propagation) — a session revoked on one edge node may remain valid on
  another
* Bad, because there are no atomic operations — rate limiting requires read-modify-write with race conditions
* Bad, because the API surface is proprietary and has no equivalent on other platforms

### In-memory Cache (Per-Isolate `Map`)

Use a `Map` within each Cloudflare Worker isolate for caching, with Turso as the fallback on cache miss.

* Good, because it requires zero additional infrastructure
* Good, because read latency is sub-millisecond
* Bad, because Cloudflare Worker isolates are ephemeral and share no state — cache hit rate would be very low
* Bad, because each isolate maintains its own copy — no consistency across instances
* Bad, because session revocation would not propagate until the cache entry expires or the isolate is recycled
* Bad, because memory is limited per isolate, with no eviction policy

## More Information

### Implementation Scope

The change affects three packages:

1. **`packages/infrastructure`** — new `cache/` module exporting `CacheClient` interface, Valkey implementation, and
   in-memory test implementation
2. **`packages/types`** — `Env` interface extended with `CACHE_URL` and optional `CACHE_TOKEN`
3. **`packages/core`** — new `createCachedSessionService` alongside existing `createSessionService`; rate limiting
   middleware using `CacheClient`

No changes to `require-auth.ts`, `token-service.ts`, or route handlers in `app.ts`.

### What Remains in libSQL

Users, credentials, and audit logs — anything relational and durable. The session table may be retained as a fallback
during migration or removed once the cache layer is validated in production.

### Portability of `getConnInfo`

The `getConnInfo` import from `hono/cloudflare-workers` in `session-service.ts` is a separate portability concern. It
should be abstracted as a `getClientIp: (ctx: AuthContext) => string` dependency injected into the session service
config, allowing Hono's runtime-specific adapters (`hono/bun`, `hono/deno`, etc.) to be swapped without modifying core.

### Deployment and Rollback

Cache-backed sessions require an explicit code change — setting `CACHE_URL` alone does not activate the feature. This is
intentional: the auth system is initialized at module level as a singleton, before any request `env` is available, so
runtime auto-detection is not possible without restructuring app initialization.

**Deploying:**

1. Provision a Valkey-compatible endpoint (Upstash, self-hosted Valkey, etc.)
2. Add `CACHE_URL` and `CACHE_TOKEN` as Worker secrets (`wrangler secret put`)
3. Wire `createValkeyClient` into `createAuthSystem` in `app.ts`
4. Deploy — new sessions are stored in cache; existing SQL sessions continue to work via the JWT refresh flow
   (users re-authenticate naturally as access tokens expire)

**Rolling back:**

1. Revert the `app.ts` change to `createAuthSystem()` (no cache factory)
2. Deploy — the app returns to SQL-backed sessions immediately
3. Active cache-backed sessions become invalid; affected users must re-authenticate
4. Cache credentials can be removed from Worker secrets at any time after rollback

**Note:** The SQL session table should be retained during the migration period. It serves as the fallback path and
requires no schema changes. Cache-backed sessions stored in Valkey expire via TTL and require no manual cleanup after
rollback.

### Relationship to ADR-002

This decision supersedes the "Start with KV" conclusion in [ADR-002 § Valkey vs KV](002-auth-enhancements.md). The rate
limiting interface defined in ADR-002 Phase 1 (`RateLimitConfig`) remains valid — only the backing store changes from KV
to the `CacheClient` abstraction.

### References

* [Valkey](https://valkey.io/) — open-source Redis-compatible key-value store (BSD-3-Clause)
* [ADR-001: Authentication Implementation](001-auth-implementation.md)
* [ADR-002: Authentication Security Enhancements](002-auth-enhancements.md)
* [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
