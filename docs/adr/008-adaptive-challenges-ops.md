# ADR-008: Adaptive Challenges and Operational Surface

- **Status:** Accepted
- **Date:** 2026-02-27
- **Decision-makers:** @vhscom

## Context and Problem Statement

[ADR-006](006-rate-limiting.md) shipped rate limiting with fail-open semantics. [ADR-004](004-password-change-endpoint.md) introduced password change with full session revocation. Neither produces a durable, queryable record of what happened — a failed login, a rate-limit rejection, or a mass session revocation are all fire-and-forget events today.

Two gaps remain:

1. **Visibility** — there is no structured record of security-relevant actions. `console.error` is ephemeral and `wrangler tail` is real-time only. Investigating a brute-force attempt or confirming a session revocation requires log aggregation infrastructure that a reference implementation should not depend on.
2. **Adaptive defense** — rate limiting applies a fixed ceiling regardless of context. An IP with zero failed logins and an IP with five consecutive failures receive identical treatment until the rate limit is exhausted. The system cannot raise the cost of continued attempts based on observed behavior.

These gaps are related: adaptive challenges need durable event history to make escalation decisions, and operational visibility needs structured events to answer questions about what happened and when.

How should we add structured event capture, adaptive bot mitigation, and operational tooling without modifying the existing authentication services?

## Decision Drivers

* **No core changes** — existing `session-service`, `account-service`, and `require-auth` must not be modified
* **Removable** — deleting the package and commenting one line in `app.ts` must restore the original system
* **No external dependencies** — SQLite/Turso for durable state; no Elasticsearch, Loki, or SIEM
* **Agent-first** — operational endpoints are consumed by automation, not human dashboards
* **Least privilege** — agents should only have the trust level they need (`read` vs `write`)
* **Fail-open** — event emission and challenge evaluation failures must never block authentication
* **Testability** — all services must be unit-testable with in-memory SQLite, no external services

## Decision Outcome

Introduce a `packages/observability` package containing structured event emission, adaptive proof-of-work challenges, and an agent-authenticated `/ops` API surface. The package integrates via Hono middleware — no modifications to existing auth services.

### 1. Structured Event Emission

A `security_event` table stores durable, queryable records of security-relevant actions:

```sql
create table if not exists security_event (
    id integer primary key,
    type text not null,
    ip_address text not null,
    user_id integer,
    detail text,
    created_at text not null default current_timestamp,
    actor_id text not null
);

create index if not exists idx_security_event_type on security_event(type);
create index if not exists idx_security_event_created on security_event(created_at);
create index if not exists idx_security_event_user on security_event(user_id);
create index if not exists idx_security_event_ip on security_event(ip_address);
```

Events are emitted via middleware that runs after the route handler completes:

```typescript
app.post("/auth/login", rateLimit(rateLimits.login), adaptiveChallenge, obsEmit("login.success"), async (ctx) => {
  // ... existing login logic, unchanged ...
});
```

The `obsEmit` middleware inspects the response status — if >= 400, it rewrites the event type to the failure variant (e.g., `login.success` → `login.failure`). An inline `obsEmitEvent` function handles cases where one handler produces multiple events (e.g., password change emits both `password.change` and `session.revoke_all`).

#### Events Captured

| Event Type | Source | Detail |
|---|---|---|
| `login.success` | `/auth/login` | `{ userId }` |
| `login.failure` | `/auth/login` | `{ email? }` (domain only) |
| `session.revoke` | `/auth/logout` | `{ sessionId }` |
| `session.revoke_all` | `/account/password` | `{ userId, count }` |
| `password.change` | `/account/password` | `{ userId }` |
| `session.ops_revoke` | `POST /ops/sessions/revoke` | `{ scope, id?, revoked }` |
| `agent.provisioned` | `POST /ops/agents` | `{ name, trustLevel }` |
| `agent.revoked` | `DELETE /ops/agents/:name` | `{ name }` |
| `agent.auth_failure` | `requireAgentKey` middleware | `{ keyHashPrefix }` |
| `challenge.issued` | `adaptiveChallenge` middleware | `{ difficulty }` |
| `challenge.failed` | `adaptiveChallenge` middleware | `{ difficulty }` |
| `rate_limit.reject` | `onLimited` callback (rate limiter) | `{ prefix }` |

**Email handling:** Failed login events store only the domain portion of the submitted email (`*@example.com`) to support abuse-pattern detection without logging credentials or full identifiers.

**Emission semantics:** Fire-and-forget via `ctx.executionCtx.waitUntil()`. Event processing happens after the response is sent. A failed write is caught, logged via `console.error`, and discarded — it never blocks the auth response.

#### Attribution

Every event records an `actor_id` identifying who caused it:

- `app:private-landing` — the application itself (login handlers, rate limiter, etc.)
- `agent:<name>` — an agent acting via `/ops/*` (e.g., session revocation)

This is essential for distinguishing user-initiated revocations from agent-initiated ones.

### 2. Adaptive Proof-of-Work Challenges

The login endpoint can require clients to solve SHA-256 proof-of-work challenges when an IP shows suspicious failure patterns. This raises the computational cost of brute-force attempts without requiring CAPTCHA infrastructure.

#### Escalation Logic

The `adaptiveChallenge` middleware runs before the login handler. It queries the `security_event` table for failure events from the requesting IP within a configurable time window (default: `login.failure`; configurable via `adaptiveChallengeFor({ eventType })` for other endpoints):

| Failures (window) | Response |
|---|---|
| 0–2 | No challenge — proceed to login |
| 3–5 | `403` with PoW challenge (difficulty 3: 3 leading zero hex digits) |
| 6+ | `403` with PoW challenge (difficulty 5: 5 leading zero hex digits) |

All thresholds and difficulty levels are configurable.

#### Challenge Protocol

```
1. Client sends POST /auth/login (no challenge headers)
   → Middleware counts recent failures for this IP
   → If threshold exceeded: return 403 with { challenge: { type: "pow", difficulty, nonce } }

2. Client computes solution: find value where SHA-256(nonce + solution) has N leading zero hex digits

3. Client resends POST /auth/login with challengeNonce and challengeSolution in body
   → Middleware verifies: re-hash nonce + solution, check leading zeros
   → If valid: proceed to credential check
   → If invalid: return 403 with new challenge
```

#### Design Properties

- **Stateless** — nonces are generated per-request and not stored server-side; verification is symmetric (re-hash and check)
- **Fail-open** — if the failure count query errors, the login proceeds without a challenge
- **Complements rate limiting** — rate limits cap request volume; PoW raises per-request cost. An IP at 4 failures has not hit the rate limit (5/300s) but already faces a PoW challenge
- **Not a CAPTCHA** — PoW does not distinguish humans from bots; it raises the cost of high-volume automated attempts. Sophisticated attackers willing to spend compute are not stopped

### 3. Agent Identity and Credentials

Agents are non-human principals that interact with the `/ops` API. Each agent has:

- **Name** (unique identifier)
- **API key** (256-bit random, returned once at provisioning, never stored)
- **Key hash** (SHA-256 of the raw key, stored in database)
- **Trust level** (`read` or `write`)

```sql
create table if not exists agent_credential (
    id integer primary key,
    name text not null unique,
    key_hash text not null,
    trust_level text not null check (trust_level in ('read', 'write')),
    created_at text not null default current_timestamp,
    revoked_at text
);

create index if not exists idx_agent_credential_name
    on agent_credential(name) where revoked_at is null;
```

**Why SHA-256, not PBKDF2?** Agent keys are 256-bit random values. Key-stretching algorithms protect low-entropy secrets (passwords) from brute-force; they add latency without security benefit for high-entropy keys.

**Why not JWT dual-token auth?** The dual-token pattern ([ADR-001](001-auth-implementation.md)) exists to balance short-lived access with seamless renewal via `HttpOnly` cookies. Agents have no browser context, no cookies, and no user behind a refresh prompt. A single long-lived key hashed with SHA-256 is appropriate for machine-to-machine communication. Compromise is mitigated by trust levels (limiting blast radius), explicit revocation, and `agent.auth_failure` events surfacing unauthorized attempts.

#### Trust Levels

| Trust | Query Events | Query Sessions | Revoke Sessions | Provision Agents |
|---|---|---|---|---|
| `read` | Yes | Yes | No | No |
| `write` | Yes | Yes | Yes | No |

Agent provisioning and revocation are gated by a separate `AGENT_PROVISIONING_SECRET` environment variable — an infrastructure concern distinct from runtime agent keys.

### 4. Operational Surface (`/ops/*`)

Operational endpoints live under `/ops`, following the semantic URL grouping from [ADR-005](005-url-reorganization.md). The prefix signals machine-consumable operational APIs — distinct from `/auth/*` (authentication lifecycle) and `/account/*` (user self-service).

#### Cloaking

When `AGENT_PROVISIONING_SECRET` is absent from the environment, all `/ops/*` routes return `404` indistinguishable from a non-existent route. This avoids revealing the operational surface in deployments where it is not needed:

```typescript
ops.use("*", async (ctx, next) => {
  if (!ctx.env.AGENT_PROVISIONING_SECRET) return ctx.notFound();
  await next();
});
```

#### Endpoints

**Provisioning (protected by `AGENT_PROVISIONING_SECRET`):**

| Endpoint | Action |
|---|---|
| `POST /ops/agents` | Provision new agent, returns raw key once |
| `DELETE /ops/agents/:name` | Soft-revoke agent (sets `revoked_at`) |

**Agent-authenticated (protected by `requireAgentKey`):**

| Endpoint | Trust | Action |
|---|---|---|
| `GET /ops/agents` | read | List active agents (no key hashes exposed) |
| `GET /ops/events` | read | Query security events with filters |
| `GET /ops/events/stats` | read | Aggregate event counts by type over a time window |
| `GET /ops/sessions` | read | List active sessions with filters |
| `POST /ops/sessions/revoke` | write | Revoke sessions by scope (`all`, `user`, `session`) |

#### Session Revocation

Three scopes enable graduated incident response:

| Scope | Payload | Effect |
|---|---|---|
| `all` | `{ "scope": "all" }` | Expire every active session globally |
| `user` | `{ "scope": "user", "id": 42 }` | Expire all sessions for a specific user |
| `session` | `{ "scope": "session", "id": "uuid" }` | Expire a single session by ID |

Revocation is immediate. When cache is enabled, revocation deletes cache keys — `requireAuth` calls `getSession` on the cache hot path ([ADR-007](007-session-dual-write.md)), so removing the key is what actually rejects the session. The SQL row is also expired for ops visibility. Without cache, `requireAuth` checks SQL `expires_at` directly, so expiring the row is sufficient.

Every revocation emits a `session.ops_revoke` event with the acting agent's identity, providing a full audit trail.

#### Event Query Parameters (`GET /ops/events`)

| Parameter | Type | Default | Description |
|---|---|---|---|
| `type` | string | — | Filter by event type (exact match) |
| `user_id` | integer | — | Filter by user ID |
| `ip` | string | — | Filter by IP address |
| `actor_id` | string | — | Filter by actor identity |
| `since` | ISO 8601 | 24h ago | Events after this timestamp |
| `limit` | integer | 50 | Max results (capped at 200) |
| `offset` | integer | 0 | Pagination offset |

#### Why `/ops/*` Is Not Rate Limited

- **Rate limiting requires cache.** The cache layer is optional ([ADR-003](003-cache-layer-valkey.md)). When disabled, rate limiting degrades to a no-op — adding the middleware provides no protection in the most common configuration.
- **Brute-force is infeasible.** Agent keys are 256-bit random values. Rate limiting does not meaningfully improve on ~2^128 average guessing resistance.
- **Revocation is the real control.** A compromised agent is revoked via `DELETE /ops/agents/:name` — immediate and final. Rate limiting delays abuse; revocation stops it.
- **Auth failures are observable.** `agent.auth_failure` events surface unauthorized key attempts without rate limits.

### 5. CLI Tooling (`plctl`)

A Go CLI using [Bubble Tea](https://github.com/charmbracelet/bubbletea) provides an interactive TUI for exercising the `/ops` surface. This is both a reference client for the API and a practical tool for development and incident response.

```
tools/cli/
├── cmd/plctl/main.go          # Bubble Tea model, views, commands
├── internal/
│   ├── api/                   # Typed HTTP client for /ops endpoints
│   │   ├── client.go          # Bearer-token HTTP transport
│   │   ├── types.go           # Request/response types
│   │   ├── agents.go          # Agent CRUD
│   │   ├── events.go          # Event queries + stats
│   │   └── sessions.go        # Session queries + revocation
│   ├── session/input.go       # Text input buffer
│   └── ui/
│       ├── styles.go          # Lipgloss styles
│       └── table.go           # Fixed-width table renderer
├── go.mod
└── go.sum
```

#### Configuration

| Environment Variable | Required | Purpose |
|---|---|---|
| `PLCTL_API_URL` | Yes | Base URL of the Private Landing instance |
| `PLCTL_API_KEY` | Yes | Agent API key (Bearer auth for `/ops` endpoints) |
| `PLCTL_PROVISIONING_SECRET` | No | Infrastructure secret for agent provisioning |

The CLI warns when `PLCTL_API_URL` does not contain `localhost`, `dev`, or `staging` — a safety check against accidentally targeting production.

#### Capabilities

The TUI presents a navigable menu organized by resource:

- **Sessions** — view active sessions, view by user, revoke (all / user / session)
- **Events** — view recent events, view by user, view aggregate stats
- **Agents** — list active agents, provision new agent, revoke agent

Write operations (revoke, provision) prompt for confirmation before executing.

## Consequences

### Positive

- Security events are durable and queryable without log aggregation infrastructure
- Adaptive challenges raise the cost of brute-force without CAPTCHA dependencies
- Every operational action is attributable to a specific agent via `actor_id`
- Plugin is fully removable — delete `packages/observability` and comment one line in `app.ts`
- Event emission is fail-open — a write failure never blocks an authentication request
- No changes to existing `account-service`, `session-service`, or `require-auth` middleware
- Schema is additive — no changes to existing `account` or `session` table schemas
- New event types can be added by emitting a new `type` string with no schema migration
- Agent provisioning is gated by a separate infrastructure secret, limiting blast radius
- CLI provides a reference client and practical incident response tool
- Go CLI has zero runtime dependency on the Node/Bun toolchain

### Negative

- SQLite is not optimized for high-volume append workloads — under sustained attack, event writes add latency (mitigated by fire-and-forget and the low request volume of an auth service)
- No real-time streaming — agents must poll to see new events
- Agent key rotation requires provisioning a new key and revoking the old one (no in-place rotation)
- `detail` as untyped JSON trades schema flexibility for query ergonomics — filtering inside `detail` requires `json_extract()` in SQLite
- PoW challenges require client-side JavaScript (or equivalent compute) — not suitable for all client types
- PoW does not distinguish humans from bots, only raises cost for high-volume automated attempts
- When cache is active, rate limiting and adaptive challenges overlap — a legitimate request may be rate-limited between receiving a challenge and submitting the solution. Acceptable for now; if it becomes a problem, solved-challenge requests could skip the rate limit increment or use a separate bucket
- Pruning requires a scheduled trigger — without it, the `security_event` table grows indefinitely
- SHA-256 is appropriate for high-entropy agent keys but would not be suitable for user passwords

## Alternatives Considered

### Structured Logs Only (`console.log` with JSON)

Emit events as structured JSON to stdout and rely on `wrangler tail` or Cloudflare Logpush.

- Good, because it requires no schema changes or database writes
- Bad, because `wrangler tail` is ephemeral and Logpush requires a paid plan
- Bad, because agents cannot query stdout logs from a remote deployment
- Rejected because it does not provide queryable, durable events without external dependencies

### Shared Admin API Key (No Per-Agent Identity)

Use a single `ADMIN_API_KEY` for all operational access.

- Good, because it is simpler — one secret, no database table
- Bad, because all callers are indistinguishable — no attribution
- Bad, because there is no way to grant read-only access
- Bad, because revoking one consumer means rotating the key for all consumers
- Rejected because it sacrifices attribution and least privilege for marginal simplicity

### CAPTCHA Instead of Proof-of-Work

Use a third-party CAPTCHA service (Turnstile, hCaptcha, reCAPTCHA) for adaptive challenge.

- Good, because CAPTCHAs distinguish humans from bots (PoW does not)
- Bad, because it introduces an external dependency and third-party JavaScript
- Bad, because it requires browser rendering — not suitable for API-only clients
- Bad, because it adds a privacy concern (third-party tracking)
- Rejected because PoW is self-contained, testable, and sufficient as a speed bump for brute-force

### Modify Core Auth Services Directly

Add event emission and challenge logic inline in `session-service.ts` and route handlers.

- Good, because it avoids a new package and plugin indirection
- Bad, because it couples observability to core auth — removing it requires editing core files
- Bad, because it violates the separation between authentication logic and operational tooling
- Rejected because the plugin pattern preserves the "delete one package" removability guarantee

## Non-Goals

- **Anomaly detection** — the system stores events; detection heuristics are an agent concern
- **Real-time alerting** — durable storage and pull-based querying, not push notifications
- **Role-based access control for users** — agent auth is separate from user auth
- **Log forwarding** — no integration with external log platforms

## Implementation Notes

- **Package:** `packages/observability/` — self-contained, depends on `@private-landing/core` and `@private-landing/infrastructure`
- **Migration:** `packages/core/src/auth/migrations/002_observability.sql`
- **Routes:** `apps/cloudflare-workers/src/routes/ops.ts`
- **CLI:** `tools/cli/cmd/plctl/main.go`
- **Wiring:** Single call in `app.ts` mounts the plugin and returns middleware factories:
  ```typescript
  const { obsEmit, obsEmitEvent, adaptiveChallenge, adaptiveChallengeFor } = observabilityPlugin(app, {
    createCacheClient: createCacheClient ?? undefined,
    getClientIp: defaultGetClientIp,
  });
  ```

## References

- [ADR-003: Cache Layer with Valkey](003-cache-layer-valkey.md) — cache is optional; events must work without it
- [ADR-004: Password Change Endpoint](004-password-change-endpoint.md) — emits `password.change` and `session.revoke_all`
- [ADR-005: URL Reorganization](005-url-reorganization.md) — semantic route grouping pattern for `/ops/*`
- [ADR-006: Rate Limiting](006-rate-limiting.md) — emits `rate_limit.reject` via `onLimited` callback; fail-open pattern reused
- [ADR-007: Session Dual-Write](007-session-dual-write.md) — ensures SQL session visibility for `/ops/sessions`
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
- [OWASP Application Logging Vocabulary](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Vocabulary_Cheat_Sheet.html)
- [NIST SP 800-92: Guide to Computer Security Log Management](https://csrc.nist.gov/pubs/sp/800/92/final)
- [Bubble Tea](https://github.com/charmbracelet/bubbletea) — Go TUI framework
