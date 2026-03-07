# Private Landing Exp v2.0 — WebSocket Bridge Prototype

Self-contained WebSocket bridge/gate with agent-key auth, PoW capability negotiation, and bidirectional JSON relay to a mock backend. Designed to later proxy to OpenClaw.

## Summary

- **Agent-key auth on upgrade**: SHA-256 hashed API key validated before WebSocket connection is established
- **PoW capability negotiation**: Server sends nonce + difficulty; client solves SHA-256 PoW; server grants capabilities based on agent trust level
- **Bidirectional relay**: Messages forwarded to/from backend, filtered by granted capability namespaces
- **Mock backend**: Standalone WS server with JSON-RPC handlers for `chat.*` methods and event broadcasting
- **Intentional simplifications**: Single-process, in-memory credential store, static PoW difficulty, console.log observability

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
};
```

## Architecture

```
Client ──[API key]──> Bridge Server (:18800/ops) ──> Mock Backend (:18790)
                       │
                       ├─ Agent key verification on upgrade
                       ├─ PoW challenge/response
                       ├─ Capability grant (trust-level based)
                       ├─ Bidirectional relay (filtered)
                       ├─ Rate limiting (10 msg/s)
                       └─ Idle timeout (30 min)
```

## Trust Levels & Capabilities

| Trust Level | Capabilities                  |
|-------------|-------------------------------|
| write       | chat, agent, presence, health |
| read        | chat, health                  |

## Configuration

In `src/index.ts`:
```typescript
const USE_MOCK = true;  // false → connect to real OpenClaw at ws://127.0.0.1:18789
```

## Mock Backend Methods

- `chat.send` — Echo message and broadcast
- `chat.history` — Return session message history
- `chat.abort` — Set abort flag for session
- `chat.inject` — Inject system/tool message into history
