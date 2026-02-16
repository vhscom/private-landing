# ADR-005: URL Reorganization

- **Status:** Accepted
- **Date:** 2026-02-16
- **Decision-makers:** @vhscom

## Context and Problem Statement

[ADR-001](001-auth-implementation.md) introduced all authentication routes under a flat `/api/*` namespace.
[ADR-002](002-auth-enhancements.md) added security headers and rate-limiting foundations on top of that structure.
[ADR-003](003-cache-layer-valkey.md) layered optional cache-backed sessions without changing route paths.
[ADR-004](004-password-change-endpoint.md) added `POST /api/account/password` and explicitly noted that a future URL
reorganization might move it to `/account/password`.

The current routing design has two problems:

1. **Implicit auth via declaration order.** Public routes (`/api/register`, `/api/login`) are defined *before* the
   `app.use("/api/*", requireAuth)` wildcard; protected routes (`/api/health`, `/api/ping`) are defined *after*.
   Authentication enforcement therefore depends on source-code ordering — reordering route definitions silently changes
   the security posture. This is fragile and non-obvious to contributors.

2. **Semantic ambiguity.** Health probes, authentication lifecycle, and account management all share the `/api/` prefix.
   The URL structure does not communicate which routes are public and which require authentication. Infrastructure tools
   that probe `/api/health` must carry credentials, which is unusual for health endpoints.

How should we restructure the URL namespace to make authentication policy explicit, support unauthenticated health
probes, and group routes by domain?

## Decision Drivers

* **Explicit over implicit auth** — each route should declare its own auth requirement, not inherit it from declaration
  order relative to a wildcard
* **Conventional health endpoints** — infrastructure probes (load balancers, uptime monitors, Kubernetes liveness/readiness)
  expect unauthenticated health checks
* **Semantic grouping** — URLs should communicate their domain: infrastructure (`/health/*`), authentication lifecycle
  (`/auth/*`), account management (`/account/*`)
* **No breaking-change churn** — the tabbed wizard UI ships in the same release, so both changes land together with no
  migration period
* **Educational clarity** — as a reference implementation, the route structure should be easy to understand and adapt

## Decision Outcome

Reorganize all routes into three groups with explicit per-route middleware:

### Public (no auth required)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Infrastructure probe — timestamp |
| `POST` | `/auth/register` | Create a new account |
| `POST` | `/auth/login` | Authenticate and receive tokens |

### Protected (requires auth)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/auth/logout` | End the current session |
| `POST` | `/account/password` | Change password (revokes all sessions) |
| `GET` | `/account/me` | Return the authenticated user's ID |

The `app.use("/api/*", requireAuth)` catch-all is removed. Each protected route declares `requireAuth` as inline
middleware (e.g., `app.post("/auth/logout", requireAuth, handler)`). This makes the auth policy visible at the route
definition and eliminates declaration-order coupling.

The `/api/ping` endpoint is replaced by `/account/me`, which returns `{ userId }` — a more descriptive name for its
actual purpose.

### Implementation Details

**Route structure in `app.ts`:**

```typescript
// Global middleware
app.use("*", securityHeaders);
app.use("*", serveStatic({ cache: "key" }));

// Health probe (public)
app.get("/health", ...);

// Auth lifecycle (public)
app.post("/auth/register", ...);
app.post("/auth/login", ...);

// Auth lifecycle (protected)
app.post("/auth/logout", requireAuth, ...);

// Account management (protected)
app.post("/account/password", requireAuth, ...);
app.get("/account/me", requireAuth, ...);
```

**Wizard UI:** The Health tab is removed (public health probes are not interesting to demo in the authentication
wizard). The wizard ships with four tabs: Register, Login, Password, Logout — all pointing at the new paths.

## Consequences

### Positive

- Auth policy is explicit at each route definition — no more implicit inheritance from declaration order
- Health endpoints are publicly accessible, following infrastructure conventions
- URL structure communicates domain grouping (`/health/*`, `/auth/*`, `/account/*`)
- No migration period — the wizard UI ships with idiomatic URLs from the start
- `/account/me` is more descriptive than `/api/ping` for its actual purpose (returning user identity)
- Route reordering cannot silently change security posture

### Negative

- All integration tests require path updates (one-time mechanical change)
- Documentation references to `/api/*` paths need updating across ADRs, audits, and flow diagrams
- External consumers (if any existed) would face a breaking change — acceptable because the old URLs were never
  published as a stable API

## Alternatives Considered

### Keep `/api/*` Prefix with Sub-grouping

Use `/api/auth/*`, `/api/account/*`, `/api/health/*` to maintain the `/api/` prefix while adding semantic grouping.

- Good, because it preserves the `/api/` convention familiar to REST API consumers
- Bad, because health endpoints would still require the catch-all auth middleware to be restructured or exempted
- Bad, because the `/api/` prefix adds no information for a single-app Worker
- Rejected because the simpler top-level grouping is clearer for an educational reference implementation

### Versioned URLs (`/v1/auth/*`)

Add API versioning to the new URL structure.

- Good, because it future-proofs against breaking changes
- Bad, because this is an educational reference, not a production API with external consumers
- Bad, because it adds complexity without demonstrating an authentication pattern
- Rejected because versioning can be added later if the project evolves toward a production API

## Future Considerations

- **API versioning** — if the project adds external consumers, versioned prefixes (`/v1/auth/*`) could be layered on
  top of the current grouping
- **OpenAPI specification** — the semantic URL grouping maps naturally to OpenAPI tags if documentation generation is
  added
- **Additional account endpoints** — the `/account/*` group provides a natural home for future features (email change,
  account deletion, profile retrieval)

## References

- [ADR-001: Authentication Implementation](001-auth-implementation.md)
- [ADR-002: Authentication Security Enhancements](002-auth-enhancements.md)
- [ADR-003: Cache Layer with Valkey](003-cache-layer-valkey.md)
- [ADR-004: Password Change Endpoint](004-password-change-endpoint.md)
