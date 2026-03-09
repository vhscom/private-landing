# ADR-010: Control Plugin

- **Status:** Accepted
- **Date:** 2026-03-07
- **Decision-makers:** @vhscom

## Context and Problem Statement

An external gateway serves a control UI on its own port (`:18789`). The UI communicates with the gateway over WebSocket using the gateway's native protocol. The gateway authenticates connections with a bearer token.

A human operator has no way to reach this control surface through Private Landing. The gateway port is not exposed to the browser, and handing the gateway token to the browser would violate the principle that infrastructure secrets stay server-side.

The pieces needed to solve this already exist independently:

1. **Private Landing auth** — login, JWT dual-token, session management ([ADR-001](001-auth-implementation.md))
2. **`/ops` surface** — agent-authenticated operational routes with cloaking ([ADR-008](008-adaptive-challenges-ops.md))
3. **Gateway** — static control UI assets + WebSocket command interface, authenticated by bearer token

How should an authenticated operator access the gateway's control surface through Private Landing without exposing the gateway directly, and how should this capability compose with the existing observability plugin?

## Decision Drivers

* **Single origin** — the browser talks only to Private Landing; no CORS, no cross-origin WebSocket
* **Token isolation** — the gateway token is a server-side secret; the browser never sees it
* **Protocol transparency** — the control UI already speaks the gateway's native protocol; the proxy should not require protocol changes on either side
* **Human-gated** — only authenticated user account 1 (the operator) can access the control surface; all other users receive 404
* **Composable plugins** — control builds on observability; the interface makes this dependency explicit and the wiring order obvious
* **Removable** — removing control does not break observability; removing observability disables control at compile time
* **Fail-closed** — missing gateway configuration disables the control surface entirely (404), not partially

## Decision Outcome

Introduce a `packages/control` plugin that adds human-authenticated access to the gateway control surface via transparent reverse proxy. The plugin layers on top of `packages/observability` and mounts routes on its `/ops` sub-router.

The proxy has two roles:

1. **HTTP reverse proxy** — serves the gateway's static control UI assets through `/ops/control/*`
2. **WebSocket transparent proxy** — relays frames between the browser and gateway, injecting the gateway token server-side on the connect handshake

The browser speaks the gateway's native protocol directly. Private Landing is invisible to both sides after the connection is established — the only transformation is replacing the browser's auth credentials with the server-side `GATEWAY_TOKEN` in the gateway connect frame.

### Plugin Dependency Model

The observability plugin owns the `/ops` sub-router, cloaking, agent credentials, and event emission. The control plugin extends this surface rather than duplicating it.

```
packages/observability  (standalone — removable on its own)
  └── packages/control  (requires observability — removing obs disables control)
```

The dependency is structural: control receives `opsRouter` from observability's return value. Removing observability makes the `obs.opsRouter` reference a compile error — the dependency fails loudly, not silently.

### Plugin Interface

The observability plugin returns the ops router and a deferred mount function, allowing control to register routes before the router is mounted on the app:

```typescript
// observabilityPlugin return (extended)
{ obsEmit, obsEmitEvent, adaptiveChallenge, opsRouter, mountAgentWs, mountOps, getClientIp }
```

The control plugin receives the ops router and its dependencies:

```typescript
export function controlPlugin(opsRouter: Hono<any>, deps: ControlPluginDeps): void;

export interface ControlPluginDeps {
  requireAuth: MiddlewareHandler;
  obsEmitEvent?: ObsEmitEventFn;
  getClientIp?: GetClientIpFn;
}
```

Gateway credentials (`GATEWAY_URL`, `GATEWAY_TOKEN`) are read from the Worker environment at request time — not passed as constructor arguments.

### Wiring in app.ts

```typescript
// [ctl-plugin 1/2] Remove this import and the call below to disable control plugin
import { controlPlugin } from "@private-landing/control";

// [obs-plugin 2/2 begin]
const obs = observabilityPlugin(app, { ... });
({ obsEmit, obsEmitEvent, adaptiveChallenge } = obs);

// [ctl-plugin 2/2 begin] Remove through end marker (and import) to disable control plugin
controlPlugin(obs.opsRouter, {
  requireAuth,
  obsEmitEvent: obs.obsEmitEvent,
  getClientIp: obs.getClientIp,
});
// [ctl-plugin 2/2 end]

obs.mountAgentWs(obs.opsRouter);
obs.mountOps();
// [obs-plugin 2/2 end]
```

The control block nests inside the obs block. Removing obs removes control automatically. Removing control alone leaves obs intact.

### Architecture

```
Browser (:8787)
  │
  ├─ POST /auth/login ──────────────────── JWT dual-token auth
  │
  ├─ GET  /ops/control/* ───── [JWT, uid=1] ──── HTTP proxy ──── Gateway (:18789)
  │                                                               ├─ Static assets
  │                                                               └─ WebSocket
  ├─ WS   /ops/ws ─┬─ Bearer ──── agent handler (observability)
  │                 └─ Cookie+uid=1 ── WS proxy ─── Gateway WS
  │                     (injects GATEWAY_TOKEN into connect frame)
  │
  └─ GET  /ops/agents, /events, ... ──── [agent key] (observability)
```

### WebSocket Multiplexing

Both observability and control need `/ops/ws` with different auth models. The control plugin registers a dispatch middleware that runs before the agent handler:

- **Bearer header** → falls through to agent handler
- **Cookie + uid=1 + gateway configured** → upgrades to proxy handler
- **Neither** → falls through; agent handler rejects

Bearer wins over cookie — explicit auth beats ambient credentials. Removing the control plugin removes the dispatch layer; the agent handler works unchanged.

### Token Injection

The only frame transformation the proxy performs:

```typescript
// When the browser sends: { type: "req", method: "connect", params: { auth: { ... } } }
// The proxy replaces:      params.auth = { token: GATEWAY_TOKEN }
// All other frames pass through unchanged.
```

The browser never sees `GATEWAY_TOKEN`. The gateway sees a properly authenticated connect request. Origin forwarding ensures the gateway accepts the proxied connection.

### Defense in Depth

| Layer | Mechanism | Failure mode |
|---|---|---|
| Authentication | `requireAuth` middleware (JWT) | 404 (cloaked) |
| Authorization | `userOneGuard` — hardcoded uid=1 | 404 (cloaked) |
| Network | Optional `CONTROL_ALLOWED_IPS` | 404 (cloaked) |
| Session binding | Heartbeat re-validates session every 25s | Close code 4010 |
| Concurrency | One active proxy per user | Old connection closed (4012) |
| Rate limiting | 10 messages/sec per connection | Close code 4029 |
| Idle timeout | 30 minutes of inactivity | Close code 4408 |
| Audit | `control.proxy`, `control.ws_connect`, `control.ws_disconnect` events | — |
| Error cloaking | Generic 502 for gateway errors; no detail forwarded | — |

Session-bound heartbeat is the critical addition. Without it, a revoked session's access token keeps the proxy open for up to 15 minutes (the access token TTL). The heartbeat closes the connection within 25 seconds of revocation.

### Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `GATEWAY_URL` | Yes | Gateway address (e.g., `http://localhost:18789`) — auto-converted to `ws://` for WebSocket |
| `GATEWAY_TOKEN` | Yes | Bearer token for gateway authentication (server-side only) |
| `CONTROL_ALLOWED_IPS` | No | Comma-separated IP allowlist (default: no restriction) |

Both `GATEWAY_URL` and `GATEWAY_TOKEN` must be present. If either is absent, control routes return 404. Observability routes are unaffected.

## Consequences

### Positive

- Operator accesses the control UI through a single authenticated origin — no exposed gateway ports, no CORS
- Gateway token never reaches the browser — server-side injection only
- Plugin dependency is a compile-time reference, not a runtime check
- Transparent proxy requires no protocol changes to the control UI or gateway
- Inherits cloaking, route grouping, and event emission from observability for free
- Session-bound heartbeat closes the revocation window from 15 minutes to 25 seconds
- Removing control leaves observability fully functional

### Negative

- Hardcoded uid=1 — acceptable for single-operator reference implementation; RBAC deferred
- Reverse proxy adds one hop of latency for static assets — negligible for a control dashboard
- `/ops/ws` multiplexing requires Bearer/cookie dispatch — if both headers are present, Bearer wins
- `observabilityPlugin` return type grows — existing destructuring is unaffected (additive)

## Alternatives Considered

### Protocol Bridge with PoW and Capability Filtering

Introduce a negotiation protocol between the browser and proxy: PoW challenge, capability request/grant, then filtered relay.

- Good, because it adds computational cost to connection attempts and limits the browser to declared capabilities
- Bad, because the control UI speaks the gateway's native protocol — a negotiation layer breaks compatibility and requires a client-side shim
- Bad, because PoW is redundant when the operator already solved PoW at login ([ADR-008](008-adaptive-challenges-ops.md)) and the proxy is gated behind JWT auth
- Bad, because capability filtering duplicates what the gateway already enforces
- Rejected because the added complexity solves problems already addressed by existing auth layers

### Expose Gateway Directly with CORS

Serve the control UI from the gateway's port and configure CORS.

- Good, because it eliminates the proxy hop
- Bad, because the gateway port must be browser-accessible — increases attack surface
- Bad, because the browser needs the gateway token — breaks token isolation
- Rejected because it defeats the purpose of server-side token management

### Peer Plugins with Mount-Order Convention

Both plugins mount independently on the app; documentation states control must mount after observability.

- Good, because neither plugin knows about the other
- Bad, because wrong mount order produces silent route shadowing, not a build error
- Rejected because implicit ordering conventions fail silently in production

### Embed Control UI in Private Landing

Bundle the control UI into Private Landing's static file serving.

- Good, because it eliminates the reverse proxy
- Bad, because it couples control UI releases to Private Landing deployments
- Rejected because proxying preserves independent release cycles

## Non-Goals

- **Multi-user access control** — only uid=1; RBAC deferred
- **Control UI development** — the plugin proxies existing assets
- **Gateway discovery** — `GATEWAY_URL` is explicitly configured
- **Session sharing** — the gateway has its own session model

## Implementation Notes

- **Package:** `packages/control/` — depends on `@private-landing/observability`, `@private-landing/infrastructure`, `@private-landing/types`
- **File structure:** `src/index.ts` (plugin entry), `src/proxy.ts` (HTTP reverse proxy), `src/bridge/handler.ts` (WebSocket proxy), `src/bridge/types.ts` (constants, close codes), `src/middleware/` (user-one-guard, ip-allowlist), `src/types.ts` (env bindings)
- **Cloaking scope:** Agent routes (`/sessions/*`, `/agents/*`, `/events/*`, `/ws`) are cloaked when `AGENT_PROVISIONING_SECRET` is absent. Control routes have their own auth chain and are cloaked when `GATEWAY_URL` is absent — the two cloaking concerns are independent
- **Deferred mounting:** `observabilityPlugin` returns `mountOps()` so all plugins register routes on `opsRouter` before it is mounted on the app via `app.route("/ops", opsRouter)`. This prevents route-snapshot ordering issues in Hono
- **Plugin removal:** `app.ts` uses nested begin/end comment markers. CI jobs verify build, typecheck, and unit tests pass after removing control alone and after removing both plugins

## References

- [ADR-008: Adaptive Challenges and Operational Surface](008-adaptive-challenges-ops.md) — observability plugin, cloaking, agent credentials
- [ADR-009: Operational WebSocket Gateway](009-ops-websocket-gateway.md) — agent WebSocket protocol, capability model
- [ADR-001: Authentication Implementation](001-auth-implementation.md) — JWT dual-token pattern
- [ADR-005: URL Reorganization](005-url-reorganization.md) — `/ops/*` semantic grouping
