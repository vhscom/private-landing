# ADR-006: Rate Limiting

- **Status:** Accepted
- **Date:** 2026-02-18
- **Decision-makers:** @vhscom

## Context and Problem Statement

[ADR-002](002-auth-enhancements.md) identified rate limiting as the first critical security gap in Phase 1.
[ADR-003](003-cache-layer-valkey.md) introduced the `CacheClient` abstraction with `incr()` and `expire()` — atomic
counters with TTL that provide the foundation for rate limiting without additional dependencies.

Authentication endpoints are inherently sensitive to brute-force and credential-stuffing attacks. Without rate limiting,
an attacker can attempt unlimited login or registration requests, making password guessing trivially parallelizable.

How should we implement rate limiting to protect authentication and account management endpoints?

## Decision Drivers

* **Leverage existing infrastructure** — `CacheClient.incr()` + `CacheClient.expire()` already provide the primitives
* **Independent configurability** — different routes have different threat profiles (login vs. health)
* **Composability** — rate limiters should stack with existing middleware (`requireAuth`, `securityHeaders`)
* **Testability** — unit tests must run without external Redis/Valkey using `createMemoryCacheClient()`
* **Availability** — cache failures must not degrade application functionality (fail open)
* **Educational clarity** — the implementation should demonstrate the fixed-window counter pattern clearly

## Decision Outcome

Implement a factory function `createRateLimiter` that accepts a `CacheClientFactory` (or `null`) and returns a function that creates Hono middleware instances. When `null` is passed, the factory produces pass-through no-op middleware. Each instance is independently configurable with its own window, max attempts, and key prefix.

### Algorithm

Fixed-window counter using `INCR` + `EXPIRE`:

```
try:
  identifier = config.key(ctx) ?? getClientIp(ctx)
  key = "{prefix}:{identifier}"
  count = INCR(key)
  if count == 1 → EXPIRE(key, windowSeconds)   // set TTL on first hit only
  if count > max → return 429 with Retry-After header
catch:
  log error, pass through                // fail open on cache errors
```

Public routes (where no identity is available) key by client IP. Authenticated routes key by user ID extracted from the
JWT payload, avoiding over-blocking users behind shared NAT or VPNs.

This approach is simple, efficient (one cache round-trip for most requests, two for the first request in a window), and
sufficient for the threat model of an authentication reference implementation.

### API Design

```typescript
interface RateLimitDeps {
  createCacheClient: CacheClientFactory;
  getClientIp?: GetClientIpFn;
}

interface RateLimitConfig {
  windowSeconds: number;
  max: number;      // max requests per window period
  prefix: string;   // cache key prefix
  key?: (ctx: Context) => string;  // custom key extractor (default: IP)
}

function createRateLimiter(deps: RateLimitDeps | null):
  (config: RateLimitConfig) => MiddlewareHandler
```

When `key` is provided, the middleware uses it to derive the rate-limit identifier instead of `getClientIp`. This enables user-based keying on authenticated routes where the JWT payload is available.

### Route Configuration

Rate limiters are applied at two levels:

1. **Group ceiling** via `app.use()` — broad limit for the entire route group (public routes only)
2. **Per-route stricter limit** via inline middleware — tighter limit for sensitive operations

| Scope | Window | Max | Prefix | Key |
|-------|--------|-----|--------|-----|
| `/auth/*` (group) | 300s | 20 | `rl:auth` | IP |
| `POST /auth/login` | 300s | 5 | `rl:login` | IP |
| `POST /auth/register` | 300s | 5 | `rl:register` | IP |
| `POST /auth/logout` | 300s | 5 | `rl:logout` | User ID |
| `POST /account/password` | 3600s | 3 | `rl:password` | User ID |

Authenticated routes use user-based keying via `ctx.get("jwtPayload").uid` instead of IP. This avoids over-blocking legitimate users behind VPNs or shared NAT, where many users share a single IP address. Since `requireAuth` runs before the rate limiter on these routes, the user identity is always available.

`/auth/logout` is registered before the `app.use("/auth/*", ...)` group limiter so it bypasses the IP-based ceiling — an authenticated user should not be prevented from logging out because other users on the same IP exhausted the group limit.

No group limiter is applied to `/account/*` — user-based per-route limits are sufficient because each authenticated request already identifies a specific user.

### Conditional Wiring

Rate limiting requires a cache backend (Valkey/Redis). Both cache-backed sessions and rate limiting are controlled by a single `createCacheClient` variable in `app.ts` (ADR-003). When set to `null`, `createRateLimiter` produces pass-through no-op middleware — no cache means no rate limiting.

**Security note:** The default configuration ships without cache enabled, meaning rate limiting is inactive out of the box. Deployments exposed to the internet should enable cache to activate brute-force protection on authentication endpoints.

```typescript
// Single toggle for all cache-backed features
const createCacheClient: CacheClientFactory | null = null;

const rateLimit = createRateLimiter(
  createCacheClient != null ? { createCacheClient } : null,
);
```

When both group and per-route limiters are active, the request must pass both. The per-route limiter provides defense in
depth — even if the group limit is not reached, sensitive endpoints have their own tighter constraints.

### Response Format

```
HTTP/1.1 429 Too Many Requests
Retry-After: {windowSeconds}

{"error": "Too many requests", "code": "RATE_LIMIT"}
```

### Chosen Limits

| Route | Limit | Key | Rationale |
|-------|-------|-----|-----------|
| `/auth/login` | 5 / 300s | IP | Prevents brute-force password guessing |
| `/auth/register` | 5 / 300s | IP | Prevents mass account creation |
| `/auth/*` (group) | 20 / 300s | IP | Catch-all ceiling for all auth endpoints |
| `/auth/logout` | 5 / 300s | User ID | Prevents session-revocation abuse |
| `/account/password` | 3 / 3600s | User ID | Stricter — password change revokes all sessions |

Conservative defaults suitable for a public demo/educational project. Prevents trivial brute-force while avoiding excessive friction for legitimate users. Can be tuned per-environment by modifying the `rateLimits` object in `app.ts`.

## Consequences

### Positive

- Very low cache write rate (only one `INCR` + occasional `EXPIRE` per request)
- Simple to understand and test — the fixed-window algorithm is straightforward
- No database writes — keeps the auth system cache-optional
- Effective against single-IP brute-force and basic credential stuffing
- Each limiter is independently configurable with clear per-route visibility in `app.ts`
- Unit-testable with `createMemoryCacheClient()` — no external services required
- `Retry-After` header enables well-behaved clients to back off automatically
- Fails open on cache errors — a cache outage does not block legitimate requests

### Negative

- Fixed-window counters allow burst traffic at window boundaries (up to 2x max in a short period)
- Pure IP-based limiting on public endpoints is vulnerable to proxy rotation and distributed attacks
- No per-username failed-login tracking — does not yet support account lockout or adaptive CAPTCHA
- `Retry-After` uses the full window duration, which can be overly conservative near the end of a window
- Requires a running cache service (Valkey/Redis) in production — rate limiting degrades to no-op when cache is not enabled via explicit code change in `app.ts`

These are acceptable for the current scope (educational/reference implementation). Future hardening can add composite keys or per-account counters if real abuse appears.

## Observability

Rate-limit rejections are returned as `429` with JSON `{ error: "Too many requests", code: "RATE_LIMIT" }`. Errors during cache operations are logged via `console.error` but do not block requests (fail-open). Consider adding structured logging with the key, count, and limit when a rejection occurs to enable abuse detection.

## Alternatives Considered

### Sliding Window Log

Track each request timestamp and count requests within the trailing window.

- Good, because it eliminates the boundary-burst problem
- Bad, because it requires storing individual timestamps (higher memory per key)
- Bad, because it adds complexity without proportional benefit for an educational reference
- Rejected because fixed-window is sufficient for the threat model

### Token Bucket

Allow bursts up to a bucket size, then rate-limit to a steady fill rate.

- Good, because it handles bursty traffic more gracefully
- Bad, because it requires tracking both token count and last-refill timestamp
- Bad, because `CacheClient` does not provide atomic multi-field operations
- Rejected because the implementation complexity exceeds the educational benefit

### Cloudflare Rate Limiting (Platform Feature)

Use Cloudflare's built-in rate limiting rules at the edge.

- Good, because it operates before the Worker executes (lower latency, lower cost)
- Good, because it handles distributed rate limiting across edge locations
- Bad, because it couples the implementation to Cloudflare's proprietary API
- Bad, because it cannot be unit-tested or demonstrated in the codebase
- Rejected because this is an educational reference — the rate limiting logic should be visible and testable

## Implementation Notes

- **Middleware implementation:** [`packages/core/src/auth/middleware/rate-limit.ts`](../../packages/core/src/auth/middleware/rate-limit.ts)
- **Concrete limit configuration:** [`apps/cloudflare-workers/src/app.ts`](../../apps/cloudflare-workers/src/app.ts) (`rateLimits` object)
- **Framework coupling:** The middleware uses Hono's `createMiddleware` factory and `MiddlewareHandler` type. Porting to another framework (Express, Fastify, etc.) requires replacing the middleware wrapper — the core algorithm (INCR + EXPIRE against `CacheClient`) is framework-agnostic.

## References

- [ADR-002: Authentication Security Enhancements](002-auth-enhancements.md) — identifies rate limiting as Phase 1
- [ADR-003: Cache Layer with Valkey](003-cache-layer-valkey.md) — provides the `CacheClient` foundation
- [OWASP Blocking Brute Force Attacks](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#protect-against-automated-attacks)
