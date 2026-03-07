# Private Landing Exp v2.0 — WebSocket Bridge Prototype

Self-contained WebSocket bridge/gate with agent-key auth, adaptive PoW capability negotiation, and bidirectional JSON relay to a mock backend. Designed to later proxy to OpenClaw.

## Summary

- **Agent-key auth on upgrade**: SHA-256 hashed API key validated before WebSocket connection is established, with expiry support
- **Adaptive PoW negotiation**: Difficulty escalates under per-IP connection pressure (8→16 leading zero bits)
- **Three-tier trust model**: `read`, `write`, `admin` with namespace-level capability gating
- **Bidirectional relay**: Messages forwarded to/from backend, filtered by granted capability namespaces
- **Heartbeat with credential re-validation**: 25s interval checks revocation/expiry on long-lived connections
- **Nonce dedup**: TTL-backed seen-set prevents replay across connection races
- **Mock backend**: Standalone WS server with JSON-RPC handlers for `chat.*` methods and event broadcasting

## Setup

```bash
cd experiments/ws-bridge
bun install
```

## Run

Terminal 1 — mock backend:
```bash
bun run mock
# Listening on ws://localhost:18790
```

Terminal 2 — bridge server:
```bash
bun run dev
# Listening on ws://localhost:18800/ops
```

## Test

```bash
bun test
```

## Client Example (JavaScript)

```javascript
import { provisionAgent } from "./src/middleware/auth";
import { solveChallenge } from "./src/bridge/relay";

// Provision an agent (in production, this happens via /ops/agents API)
const { rawKey } = await provisionAgent("my-agent", "write");

// Connect with the raw key
const ws = new WebSocket("ws://localhost:18800/ops", {
  headers: { Authorization: `Bearer ${rawKey}` },
});

ws.onmessage = async (ev) => {
  const msg = JSON.parse(ev.data);

  if (msg.type === "negotiate") {
    const diffMatch = msg.challenge.match(/difficulty (\d+)/);
    const difficulty = diffMatch?.[1] ? parseInt(diffMatch[1], 10) : 8;
    const solution = await solveChallenge(msg.nonce, difficulty);
    ws.send(JSON.stringify({
      type: "negotiate",
      solution,
      capabilities: ["chat", "health"],
    }));
  }

  if (msg.type === "negotiated") {
    ws.send(JSON.stringify({
      type: "relay",
      method: "chat.send",
      params: { content: "Hello from client!" },
      id: 1,
    }));
  }

  // Keep connection alive
  if (msg.type === "heartbeat") {
    ws.send(JSON.stringify({ type: "ping", id: "k1" }));
  }
};
```

## Architecture

```
Client ──[API key]──> Bridge Server (:18800/ops) ──> Mock Backend (:18790)
                       │
                       ├─ Agent key verification on upgrade (+ expiry check)
                       ├─ Adaptive PoW challenge/response
                       ├─ Capability grant (trust-level based)
                       ├─ Bidirectional relay (namespace-filtered)
                       ├─ Heartbeat (25s credential re-validation)
                       ├─ Nonce replay prevention (TTL seen-set)
                       ├─ Rate limiting (10 msg/s)
                       └─ Idle timeout (30 min)
```

## Trust Levels & Capabilities

| Trust Level | Capabilities                          |
|-------------|---------------------------------------|
| admin       | chat, agent, presence, health, system |
| write       | chat, agent, presence, health         |
| read        | chat, health                          |

## Adaptive PoW Difficulty

| Connections/IP (60s window) | Difficulty (leading zero bits) |
|-----------------------------|-------------------------------|
| < 10                        | 8 (~256 hashes)               |
| 10–24                       | 8–16 (linear interpolation)   |
| ≥ 25                        | 16 (~65K hashes)              |

## Configuration

```bash
PORT=18800                              # Bridge server port (default: 18800)
BACKEND_URL=ws://127.0.0.1:18789       # Backend WebSocket URL (default: ws://localhost:18790)
```

## Mock Backend Methods

- `chat.send` — Echo message and broadcast
- `chat.history` — Return session message history
- `chat.abort` — Set abort flag for session
- `chat.inject` — Inject system/tool message into history
