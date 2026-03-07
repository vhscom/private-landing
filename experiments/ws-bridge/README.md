# Private Landing Exp v2.0 — WebSocket Bridge Prototype

Self-contained WebSocket bridge/gate with JWT auth, HMAC-signed PoW capability negotiation, and bidirectional JSON relay to a mock backend. Designed to later proxy to OpenClaw.

## Summary

- **JWT auth on upgrade**: Bearer token validated before WebSocket connection is established
- **PoW capability negotiation**: Server sends nonce + difficulty; client solves SHA-256 PoW; server grants capabilities based on JWT role claims
- **Bidirectional relay**: Messages forwarded to/from backend, filtered by granted capability namespaces
- **Mock backend**: Standalone WS server with JSON-RPC handlers for `chat.*` methods and event broadcasting
- **Intentional simplifications**: Single-process, in-memory state, mock HMAC (SHA-256 PoW), console.log observability

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
bun run test
```

## Client Example (JavaScript)

```javascript
import { SignJWT } from "jose";

const secret = new TextEncoder().encode("exp-v2-prototype-secret-replace-me");

// Create a token
const token = await new SignJWT({ sub: "user1", roles: ["admin"] })
  .setProtectedHeader({ alg: "HS256" })
  .setSubject("user1")
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(secret);

// Connect
const ws = new WebSocket("ws://localhost:18800/ops", {
  headers: { Authorization: `Bearer ${token}` },
});

ws.onmessage = async (ev) => {
  const msg = JSON.parse(ev.data);
  console.log("<<", msg);

  if (msg.type === "negotiate") {
    // Solve PoW (difficulty 8 = 1 leading zero byte in SHA-256)
    let counter = 0;
    while (true) {
      const input = new TextEncoder().encode(msg.nonce + counter);
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
      if (hash[0] === 0) {
        ws.send(JSON.stringify({
          type: "negotiate",
          solution: counter.toString(),
          capabilities: ["chat", "health"],
        }));
        break;
      }
      counter++;
    }
  }

  if (msg.type === "negotiated") {
    // Send a chat message
    ws.send(JSON.stringify({
      type: "relay",
      method: "chat.send",
      params: { content: "Hello from client!" },
      id: 1,
    }));
  }
};
```

## Client Example (wscat)

wscat doesn't support custom headers, so use the JS snippet above or curl for initial testing.

## Architecture

```
Client ──[JWT]──> Bridge Server (:18800/ops) ──> Mock Backend (:18790)
                   │
                   ├─ JWT validation on upgrade
                   ├─ PoW challenge/response
                   ├─ Capability grant (role-based)
                   ├─ Bidirectional relay (filtered)
                   ├─ Rate limiting (10 msg/s)
                   └─ Idle timeout (30 min)
```

## Roles & Capabilities

| Role     | Capabilities                        |
|----------|-------------------------------------|
| admin    | chat, agent, presence, health       |
| operator | chat, presence, health              |
| viewer   | chat, health                        |

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
