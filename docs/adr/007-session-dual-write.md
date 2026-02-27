# ADR-007: Session Dual-Write

- **Status:** Accepted
- **Date:** 2026-02-27
- **Decision-makers:** @vhscom

## Context and Problem Statement

[ADR-003](003-cache-layer-valkey.md) introduced cache-backed sessions via `createCachedSessionService`. When enabled, all session state moves into Valkey — the SQL `session` table receives no writes. This is correct for auth performance (cache is the hot path), but creates an operational blind spot: any tooling that queries the `session` table directly sees stale or empty results.

[ADR-006](006-rate-limiting.md) demonstrated the pattern of cache-first with SQL fallback for rate limiting. Sessions need a similar approach — cache remains authoritative for authentication decisions, but SQL should reflect the current session landscape for operational queries.

How should we maintain SQL session visibility without sacrificing the latency benefits of cache-backed authentication?

## Decision Drivers

* **Cache remains authoritative** — auth decisions read from cache; SQL must not be on the hot path
* **Best-effort, non-blocking** — a SQL write failure must never block or fail an authentication request
* **No new infrastructure** — the `session` table already exists in every deployment
* **Operational visibility** — session queries should return consistent results regardless of backend
* **Minimal latency impact** — login is the only write path; reads (the vast majority) are unaffected

## Decision Outcome

A `createMirroredSessionService` decorator wraps any `SessionService` (typically the cache-backed one) with best-effort SQL writes. The inner service handles cache operations unchanged; the decorator adds SQL mirrors after each mutation. SQL writes are fire-and-forget — failures are caught and logged via `console.error`, never propagated to the caller.

```typescript
const sessionService = createMirroredSessionService({
  inner: createCachedSessionService({ createCacheClient, getClientIp }),
  createDbClient,
});
```

### Write Paths

| Operation | Cache (primary) | SQL (secondary) |
|-----------|----------------|-----------------|
| `createSession` | `SET session:{id}` with TTL | `INSERT INTO session (...)` |
| `endSession` | `DEL session:{id}` | `UPDATE session SET expires_at = datetime('now') WHERE id = ?` |
| `endAllSessionsForUser` | `DEL` all user session keys | `UPDATE session SET expires_at = datetime('now') WHERE user_id = ?` |

### Error Handling

```typescript
// Pattern used in all mirrored write paths
try {
  await db.execute({ sql, args });
} catch (err) {
  console.error("[mirrored-session] create failed:", err);
  // intentionally swallowed — inner service write already succeeded
}
```

### Consistency Model

Cache is authoritative for authentication. SQL is eventually consistent for operational visibility. If the SQL write fails, the session is still valid (cache has it) and revocable (cache keys are discoverable), but invisible to SQL-based queries until the next successful write. This is acceptable because operational queries are advisory, not authoritative.

### Decorator Pattern

The mirrored service does not modify `createCachedSessionService`. It wraps the `SessionService` interface, delegating all calls to the inner service first, then performing SQL writes. `getSession` is passed through without SQL interaction (read-only on the cache hot path). This keeps the cache service clean and makes the mirror independently removable.

## Consequences

### Positive

- Operational queries (`SELECT * FROM session WHERE expires_at > datetime('now')`) return accurate data regardless of session backend
- Session audit trail is preserved in SQL even when cache is the primary store
- Zero changes to `require-auth.ts`, `cached-session-service.ts`, or route handlers — the `SessionService` interface is unchanged
- SQL write adds ~1–2ms to login — acceptable given logins are infrequent relative to session reads
- Rollback is trivial: disabling cache reverts to SQL-only sessions with no data loss

### Negative

- Dual-write adds latency (~1–2ms) to session creation — negligible for login, but measurable
- If SQL writes fail persistently, operational visibility degrades until the underlying issue is resolved
- SQL and cache can diverge temporarily — there is no reconciliation mechanism
- New file adds ~110 lines (decorator + config type)

## Alternatives Considered

### Read from Cache in Operational Queries

Query Valkey directly from operational endpoints instead of maintaining SQL copies.

- Good, because it eliminates the dual-write entirely
- Bad, because cache is optional ([ADR-003](003-cache-layer-valkey.md)) — operational queries would fail in the default configuration
- Bad, because Valkey has no SQL-like filtering — session queries by user, expiry range, or pagination would require scanning all keys
- Rejected because it couples operational visibility to an optional infrastructure component

### Periodic Sync Job

Run a scheduled task to copy cache state into SQL at regular intervals.

- Good, because it decouples the write paths — no per-request overhead
- Bad, because Cloudflare Workers have no native cron facility for sub-minute intervals
- Bad, because the sync window creates a visibility gap — new sessions are invisible until the next sync
- Rejected because best-effort inline writes are simpler and provide near-real-time visibility

### Write-Through Cache (SQL Primary)

Write to SQL first, then populate cache as a read-through optimization.

- Good, because SQL is always consistent — no visibility gap
- Bad, because it puts SQL on the critical auth path, negating the latency benefit of cache-backed sessions
- Bad, because it reverses the architecture established in [ADR-003](003-cache-layer-valkey.md)
- Rejected because it contradicts the "cache is authoritative" principle

## Implementation Notes

- **New service:** `packages/core/src/auth/services/mirrored-session-service.ts`
- **No modifications** to `cached-session-service.ts` — decorator wraps the existing service
- **Testing:** 5 tests in `mirrored-session-service.test.ts` verify SQL INSERT, UPDATE on end, UPDATE on endAll, read passthrough, and fail-open on DB error

## References

- [ADR-003: Cache Layer with Valkey](003-cache-layer-valkey.md) — establishes cache-backed sessions
- [ADR-006: Rate Limiting](006-rate-limiting.md) — demonstrates fail-open cache pattern
