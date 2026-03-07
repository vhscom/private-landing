# ADR-010: Control Bridge Plugin

- **Status:** Proposed
- **Date:** 2026-03-07
- **Decision-makers:** @vhscom

## Context and Problem Statement

[ADR-008](008-adaptive-challenges-ops.md) and [ADR-009](009-ops-websocket-gateway.md) established the `/ops` surface for agent-authenticated operational access. The WebSocket bridge experiment (`experiments/ws-bridge`) validated a gateway handshake protocol with adaptive PoW, capability-filtered relay, and heartbeat credential re-validation.

The missing piece is the front door. A human operator currently has no path from browser login to the gateway control UI. The pieces exist independently:

1. **Private Landing human auth** — login, JWT dual-token, session management
2. **WebSocket bridge** — gateway handshake, PoW negotiation, capability relay
3. **Control UI** — static assets served by the gateway on `:18789`

But there is no route that authenticates a human, serves the control UI, and bridges WebSocket connections to the gateway — all through a single origin.

Two concerns compound the integration question:

1. **Plugin composability** — the observability plugin ([ADR-008](008-adaptive-challenges-ops.md)) established a plugin pattern (import + one call in `app.ts`). A second plugin that depends on the first tests whether that pattern scales. If control requires observability, the interface must express that dependency cleanly — not through documentation warnings about mount order.
2. **Token isolation** — the gateway token is an infrastructure secret. The browser must never see it. The bridge injects it server-side, but the plugin interface must make this boundary explicit.

How should we connect human authentication to the gateway bridge, and how should the plugin interface express the dependency between control and observability?

## Decision Drivers

* **Single origin** — the browser talks only to Private Landing; no CORS, no cross-origin WebSocket
* **Token isolation** — the gateway token is a server-side secret; the browser never sees it
* **Human-gated** — only authenticated user account 1 (the operator) can access the control surface; all other users receive 404
* **Composable plugins** — control builds on observability; the interface makes this dependency explicit and the wiring order obvious
* **Removable** — removing control does not break observability; removing observability disables control automatically
* **No new auth model** — reuses existing JWT dual-token auth for the human side and the bridge's gateway token injection for the machine side
* **Fail-closed** — missing `GATEWAY_URL` or `GATEWAY_TOKEN` disables the control plugin entirely (404), not partially

## Decision Outcome

Introduce a `packages/control` plugin that layers on top of `packages/observability` to add human-authenticated access to the gateway control surface.

### Plugin Dependency Model

The observability plugin already owns the `/ops` sub-router, cloaking middleware, agent credentials, and event emission. The control plugin does not duplicate any of this — it extends the existing surface with two new capabilities:

1. **Static asset proxying** — reverse proxy to the gateway for control UI assets
2. **WebSocket bridging** — JWT-authenticated upgrade that bridges to the gateway

This means control depends on observability. The dependency is structural, not incidental — control needs the `/ops` router, the cloaking guard, and event emission for audit logging bridge connections.

```
packages/observability  (standalone — removable on its own)
  └── packages/control  (requires observability — removing obs disables control)
```

Removing observability removes both plugins. Removing control leaves observability intact. This is the correct dependency direction — operational tooling is foundational; a control UI is optional.

### Plugin Interface

The observability plugin currently returns middleware factories. To support composition, it also returns the ops router and its dependencies, allowing control to mount additional routes on the same sub-router:

```typescript
// packages/observability/src/index.ts (extended)
export function observabilityPlugin(app, deps) {
  const opsRouter = createOpsRouter(deps);
  app.route("/ops", opsRouter);
  // ... existing middleware factories ...
  return { obsEmit, obsEmitEvent, adaptiveChallenge, adaptiveChallengeFor, opsRouter };
}
```

The control plugin receives the ops router and mounts its routes on it:

```typescript
// packages/control/src/index.ts
export function controlPlugin(
  opsRouter: Hono<OpsEnv>,
  deps: ControlPluginDeps,
): void;

export interface ControlPluginDeps {
  requireAuth: MiddlewareHandler;
  obsEmitEvent?: ObsEmitEventFn;  // from observability, for audit logging
  gatewayUrl?: string;             // default: env.GATEWAY_URL
  gatewayToken?: string;           // default: env.GATEWAY_TOKEN
}
```

### Wiring in app.ts

```typescript
// [obs-plugin 1/2] Remove this import and the override below to disable observability
import { observabilityPlugin } from "@private-landing/observability";
// [control-plugin 1/2] Remove this import and the call below to disable control bridge
import { controlPlugin } from "@private-landing/control";

// [obs-plugin 2/2] Remove this override and the import above to disable observability
const { obsEmit, obsEmitEvent, adaptiveChallenge, opsRouter, mountAgentWs } =
  observabilityPlugin(app, {
    createCacheClient: createCacheClient ?? undefined,
    getClientIp: defaultGetClientIp,
  });

// [control-plugin 2/2] Remove this call and the import above to disable control bridge
// When control is absent, uncomment mountAgentWs to restore agent-key WS access.
controlPlugin(opsRouter, { requireAuth, obsEmitEvent });
// mountAgentWs(opsRouter);
```

The dependency is visible in the code: `controlPlugin` receives `opsRouter` from `observabilityPlugin`. Remove the observability lines and `opsRouter` does not exist — the control call fails at compile time, not at runtime. This is deliberate. A runtime check ("is observability loaded?") would hide the dependency; a compile-time reference makes it explicit.

The WebSocket handler is mutually exclusive — either control owns `/ops/ws` (JWT auth, bridge to gateway) or observability does (agent-key auth, direct gateway). The choice is expressed in `app.ts` by which call is active, not by route priority.

### Architecture

```
Browser
  |
  v
Private Landing (:8787)
  |-- POST /auth/login --> JWT dual-token auth (existing)
  |-- /ops/*           --> [cloak guard from observability]
  |   |-- GET /ops/agents, /ops/events, ... --> [agent key auth] (observability)
  |   |-- GET /ops/control/*               --> [JWT auth, user 1] --> proxy to gateway
  |   |-- WS  /ops/ws                      --> [JWT auth, user 1] --> bridge --> gateway
  |
  v
Gateway (:18789)
  |-- Static assets (control UI)
  |-- WebSocket (operational commands)
```

### Route Namespacing

The control plugin mounts under `/ops/control/*` for static assets, avoiding collision with observability's existing `/ops/*` HTTP routes.

| Path | Auth | Handler | Plugin |
|---|---|---|---|
| `/ops/agents` | Agent key | Agent CRUD | Observability |
| `/ops/events` | Agent key | Event queries | Observability |
| `/ops/sessions` | Agent key | Session queries | Observability |
| `/ops/control/*` | JWT (user 1) | Reverse proxy to gateway | Control |
| `/ops/ws` | JWT (user 1) or Agent key | WebSocket bridge or agent gateway | Control or Observability |

#### WebSocket Handler: Mutual Exclusion

Observability ([ADR-009](009-ops-websocket-gateway.md)) and control both want `/ops/ws`, but with different auth models. Hono matches routes in registration order — registering both on the same router means the first one wins, reintroducing the ordering problem we rejected.

The solution: observability does not register `/ops/ws` by default. Instead, `observabilityPlugin` returns a `mountAgentWs` function alongside the ops router. The WebSocket handler is mounted explicitly in `app.ts`, making the choice visible:

```typescript
const { obsEmit, obsEmitEvent, adaptiveChallenge, opsRouter, mountAgentWs } =
  observabilityPlugin(app, deps);

// When control is active, it owns /ops/ws (JWT auth, bridge to gateway):
controlPlugin(opsRouter, { requireAuth, obsEmitEvent });

// When control is absent, uncomment to restore agent-key WS:
// mountAgentWs(opsRouter);
```

Only one WebSocket handler is active at a time. The mutual exclusion is expressed in code, not in route priority rules. Removing the `controlPlugin` call and uncommenting `mountAgentWs` restores the original agent-key behavior with no other changes.

### HTTP Reverse Proxy

Authenticated requests to `/ops/control/*` are proxied to the gateway:

```typescript
opsRouter.all("/control/*", requireAuth, userOneGuard, async (c) => {
  const target = new URL(c.req.url);
  target.pathname = target.pathname.replace("/ops/control", "");
  target.host = gatewayHost;
  target.port = gatewayPort;
  return fetch(target.toString(), c.req.raw);
});
```

The `userOneGuard` middleware checks `jwtPayload.uid === 1` and returns 404 for all other users — indistinguishable from a non-existent route, matching the cloaking pattern from [ADR-008](008-adaptive-challenges-ops.md).

Gateway error responses are not forwarded verbatim — the proxy returns a generic `502 Bad Gateway` with no body detail. This prevents gateway internals (error messages, stack traces, internal structure) from leaking through Private Landing to the browser. Successful responses (2xx) are proxied as-is.

### WebSocket Bridge

The `/ops/ws` route validates the JWT, checks user ID 1, then upgrades to WebSocket. The bridge:

1. Receives the upgrade with the human's authenticated identity
2. Opens a backend connection to the gateway
3. Completes the gateway handshake, injecting `GATEWAY_TOKEN` server-side
4. Relays messages between browser and gateway, filtered by granted capabilities

The bridge extracts the relay logic from `experiments/ws-bridge` into `packages/control`: adaptive PoW for the capability negotiation, capability-filtered forwarding, heartbeat with credential re-validation, and nonce replay prevention. The experiment was tested against both a mock backend and a live OpenClaw gateway server.

### Runtime Target: Cloudflare Workers

Private Landing deploys to Cloudflare Workers. The experiment used Bun-native APIs (`ServerWebSocket`, `Bun.serve`) for rapid prototyping, but the plugin targets Workers — the same runtime as the rest of the application.

The bridge has two WebSocket roles with different API requirements:

| Role | Direction | Workers API |
|---|---|---|
| Front door (browser → Private Landing) | Server | `WebSocketPair` via `upgradeWebSocket` from `packages/observability/src/ws/upgrade.ts` |
| Back door (Private Landing → gateway) | Client | Standard `new WebSocket(url)` constructor (available in Workers runtime) |

The front door reuses observability's `upgradeWebSocket` wrapper, which fixes the missing `onOpen` event in Hono's Cloudflare Workers adapter ([ADR-009 implementation notes](009-ops-websocket-gateway.md#implementation-notes)). The back door uses the standard `WebSocket` constructor — Workers supports outbound WebSocket connections natively.

The relay extraction from the experiment is a port, not a copy. Bun-specific types (`ServerWebSocket<WsData>`, `Bun.serve`) are replaced with the Hono/Workers equivalents (`WSContext`, `WebSocketPair`). The protocol logic (PoW verification, capability filtering, frame translation, heartbeat) is runtime-agnostic and transfers directly.

The local dev server (`bun run dev`) runs on Bun, but uses the same Workers-compatible code paths — the `upgradeWebSocket` wrapper and standard `WebSocket` constructor both work in Bun's runtime. No Bun-specific code paths are needed in the plugin.

The browser never sees `GATEWAY_TOKEN`. From the browser's perspective, it opens a WebSocket to its own origin (`ws://localhost:8787/ops/ws`) and speaks the bridge protocol. The bridge translates between the browser's relay messages and the gateway's frame protocol.

### Auth Swap: JWT Replaces Agent Key

The experiment's bridge authenticates via agent keys (`verifyAgentKey`). The plugin replaces this with the existing `requireAuth` middleware, which performs the full JWT verification chain — signature validation, expiry check, session lookup, and token refresh. The bridge adds only the user 1 guard on top; it does not reimplement any JWT logic.

| Concern | Experiment (agent key) | Plugin (JWT) |
|---|---|---|
| Front-door auth | `Authorization: Bearer <agent-key>` | `requireAuth` middleware (cookie-based JWT) |
| Identity | `AgentPrincipal` from credential store | `jwtPayload.uid` from access token |
| Trust level | Agent credential's `trustLevel` | Hardcoded `admin` for user 1 |
| Gateway auth | `GATEWAY_TOKEN` injected in connect frame | Same — unchanged |
| Capability negotiation | PoW + trust-scoped capabilities | Same — unchanged |

The bridge constructs a synthetic `AgentPrincipal` from the JWT claims:

```typescript
const agent: AgentPrincipal = {
  id: `user:${payload.uid}`,
  name: `user-${payload.uid}`,
  trustLevel: "admin",
};
```

### Defense in Depth

The user 1 check is the primary access gate, but the control surface handles a browser-based threat model that agent keys do not. Four additional mechanisms layer on top:

#### IP Allowlist

An optional `CONTROL_ALLOWED_IPS` environment variable restricts control routes to specific source IPs (e.g., `127.0.0.1,10.0.0.0/8`). When set, requests from other IPs receive 404 — same cloaking response as an unauthorized user. This blocks remote exploitation of a stolen JWT cookie; the attacker must also be on the allowed network.

When unset, IP filtering is disabled — the user 1 check and JWT auth are the only gates. This preserves zero-config local development.

#### Session-Bound Bridge

When the WebSocket opens, the bridge captures the Private Landing session ID from the JWT's `sid` claim. On each heartbeat cycle (every 25 seconds), the bridge re-validates that the session is still active — not just the credential, the actual session in the database.

If the operator logs out or the session is revoked (via `/auth/logout`, `/account/password`, or `/ops/sessions/revoke`), the bridge drops within one heartbeat interval. Without this check, a revoked session's access token remains valid until expiry (up to 15 minutes) — the bridge would stay open for that window.

This reuses the heartbeat infrastructure from the experiment. The experiment re-validates agent credentials; the plugin re-validates Private Landing sessions. Same mechanism, different backing store.

#### Audit Trail

Every control surface access emits a structured event via `obsEmitEvent`:

| Event Type | Trigger | Detail |
|---|---|---|
| `control.proxy` | HTTP request proxied to gateway | `{ path, method }` |
| `control.ws_connect` | WebSocket bridge established | `{ userId, sessionId }` |
| `control.ws_disconnect` | WebSocket bridge closed | `{ userId, code, reason }` |

These events are queryable in the `security_event` table alongside existing login, session, and agent events. The observability dependency makes this essentially free — `obsEmitEvent` is already injected via the plugin interface.

#### Concurrent Connection Limit

Only one active bridge connection is allowed per user. A second connection from the same user closes the first with close code `4012` (superseded). This prevents a leaked session from being silently exploited while the real operator is also connected — or at minimum makes the takeover visible (the operator's connection drops).

The limit is enforced in the bridge relay via a `Map<userId, WebSocket>` — when a new connection arrives for a user that already has an active bridge, the old connection is closed before the new one proceeds.

### Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `GATEWAY_URL` | Yes | WebSocket URL of the gateway (e.g., `ws://localhost:18789`) |
| `GATEWAY_TOKEN` | Yes | Bearer token for gateway authentication |
| `CONTROL_ALLOWED_IPS` | No | Comma-separated IP allowlist for control routes (default: no restriction) |

`GATEWAY_URL` and `GATEWAY_TOKEN` must both be present for the plugin to activate. If either is absent, the control plugin's routes return 404. Observability routes remain unaffected.

## Consequences

### Positive

- Human operator accesses the control UI through a single authenticated origin — no CORS configuration, no exposed gateway ports
- Gateway token is a server-side secret — browser JavaScript cannot extract or leak it
- Plugin dependency is a compile-time reference (`opsRouter`), not a runtime check — removing observability breaks the build, not the running system
- Control mounts on the existing `/ops` sub-router — inherits cloaking, route grouping, and middleware chain for free
- Reuses validated bridge logic from the experiment — no new WebSocket protocol design
- User 1 guard with 404 response maintains the cloaking pattern — unauthorized users cannot distinguish `/ops/control` from a non-existent path
- Defense in depth: IP allowlist, session-bound bridge, audit trail, and concurrent connection limit layer on top of the user 1 check — each addresses a distinct browser-based threat
- Session-bound bridge closes within one heartbeat of session revocation — no 15-minute access token window
- No new auth model — JWT for humans, gateway token for machine-to-machine, both existing
- Removing control leaves observability fully functional — the dependency is one-directional

### Negative

- Hardcoded user ID 1 does not scale to multiple operators — acceptable for a single-operator reference implementation; role-based access is a future concern
- Reverse proxy adds latency for static assets — one extra hop through Private Landing; negligible for a control dashboard
- `/ops/ws` is mutually exclusive — when control is active, agent-key WebSocket access is unavailable through Private Landing; agents that need WebSocket access must connect to the gateway directly
- Bridge runs in the Private Landing process — a misbehaving gateway connection could affect auth request handling (mitigated by timeouts and the concurrent connection limit)
- IP allowlist requires the operator to know their network topology — misconfigured allowlist locks out the operator (mitigated by the allowlist being optional and fail-open when unset)
- `observabilityPlugin` return type grows to include `opsRouter` — a minor API change, but existing callers that destructure only `{ obsEmit, obsEmitEvent, adaptiveChallenge }` are unaffected

## Alternatives Considered

### Peer Plugins with Mount-Order Convention

Both plugins mount independently on the app, with documentation stating control must mount after observability.

- Good, because neither plugin needs to know about the other's internals
- Bad, because mount order is a runtime convention — getting it wrong produces silent route shadowing, not a build error
- Bad, because both plugins would need their own cloaking middleware, duplicating the guard
- Rejected because implicit ordering conventions are the kind of bug that survives code review and fails in production

### Control Subsumes Observability

Merge observability into control as a single larger plugin.

- Good, because it eliminates the composition question entirely
- Bad, because it violates the removability contract — you can no longer have observability without the control UI
- Bad, because it couples event emission (needed by auth routes) to gateway proxying (needed by nobody until a gateway exists)
- Rejected because the current separation correctly reflects that observability is foundational and control is optional

### Expose Gateway Directly with CORS

Serve the control UI from the gateway's port and configure CORS to accept requests from Private Landing's origin.

- Good, because it eliminates the proxy hop for static assets
- Bad, because the gateway port must be exposed to the browser — increases attack surface
- Bad, because the browser must know the gateway token to authenticate WebSocket connections — token is no longer server-side only
- Rejected because it defeats the purpose of token isolation

### Separate Control App

Run a dedicated application for the control UI with its own auth.

- Good, because it fully decouples control from authentication
- Bad, because it requires a second deployment, second domain, and second auth flow
- Rejected because the plugin pattern achieves the same result with less infrastructure

### Embed Control UI in Private Landing Static Assets

Bundle the control UI into Private Landing's static file serving.

- Good, because it eliminates the reverse proxy entirely
- Bad, because it couples control UI releases to Private Landing deployments
- Rejected because proxying preserves independent release cycles

## Non-Goals

- **Multi-user access control** — only user 1 is supported; RBAC is deferred
- **Control UI development** — the plugin proxies existing assets; it does not build or bundle them
- **Gateway discovery** — `GATEWAY_URL` is explicitly configured, not auto-discovered
- **Session sharing between Private Landing and gateway** — the gateway has its own session model (`sessionKey`); Private Landing sessions are not forwarded
- **Replacing agent-key auth for plctl** — `plctl` continues to use agent keys over the gateway's WebSocket directly; the control plugin serves browser-based human access only

## Deferred

- **Role-based operator access** — when multiple users need control access, introduce an authorization mechanism (e.g., an allowlist, a permission column on `account`, or a separate operator table) and replace the user ID 1 check
- **Static asset caching** — the reverse proxy could cache gateway assets locally to reduce latency; deferred because the control UI is lightweight
- **Health-aware proxying** — the proxy could check gateway health before forwarding; deferred because a failed proxy returns a generic 502 to the browser, which is sufficient
- **Plugin interface formalization** — if a third plugin emerges, extract a `PluginMount` interface or registration pattern. Two plugins do not justify the abstraction; three might

## Implementation Notes

- **Package:** `packages/control/` — depends on `@private-landing/observability` (for `opsRouter` type and `obsEmitEvent`) and `@private-landing/core` (for `requireAuth` type)
- **Relay extraction:** The relay protocol logic (PoW, capability filtering, frame translation, heartbeat) ports from `experiments/ws-bridge/src/` to `packages/control/src/bridge/`, replacing Bun-native WebSocket APIs with Workers-compatible equivalents (`WSContext`, `WebSocketPair`, standard `WebSocket` constructor). The experiment directory can be archived or kept as a standalone test harness
- **Observability change:** `observabilityPlugin` returns `opsRouter` in addition to existing middleware factories. This is additive — existing destructuring patterns continue to work
- **Route mounting:** Control plugin calls `opsRouter.all("/control/*", ...)` and `opsRouter.get("/ws", ...)` — routes are added to the same sub-router that observability created, inheriting its middleware stack
- **Testing:** Unit tests mock the gateway WebSocket and verify JWT-to-bridge auth swap, user 1 guard, and proxy forwarding. Integration tests reuse the mock backend from the experiment
- **Environment:** `GATEWAY_URL` and `GATEWAY_TOKEN` in Worker env (`.dev.vars` for local development)

## References

- [ADR-008: Adaptive Challenges and Operational Surface](008-adaptive-challenges-ops.md) — observability plugin pattern, cloaking, agent credentials
- [ADR-009: Operational WebSocket Gateway](009-ops-websocket-gateway.md) — gateway protocol, capability model, heartbeat
- [ADR-001: Authentication Implementation](001-auth-implementation.md) — JWT dual-token pattern reused for human auth
- [ADR-005: URL Reorganization](005-url-reorganization.md) — `/ops/*` semantic grouping
