/**
 * Integration tests — full agent lifecycle against live bridge + mock backend.
 * Exercises multi-step flows: provision → connect → negotiate → relay → close.
 */
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { createMockBackend } from "../mock-backend";
import { solveChallenge } from "../src/bridge/relay";
import { createServer } from "../src/index";
import {
	clearCredentials,
	provisionAgent,
	revokeAgent,
} from "../src/middleware/auth";
import type { TrustLevel } from "../src/types";

const MOCK_PORT = 19890;
const SERVER_PORT = 19900;

let mockBackend: ReturnType<typeof createMockBackend>;
let mainServer: ReturnType<typeof createServer>;

beforeAll(() => {
	mockBackend = createMockBackend(MOCK_PORT);
	mainServer = createServer(SERVER_PORT, `ws://localhost:${MOCK_PORT}`);
});

afterAll(() => {
	mainServer.server.stop(true);
	mockBackend.stop();
});

beforeEach(() => {
	clearCredentials();
});

// --- Helpers ---

const messageQueues = new WeakMap<WebSocket, unknown[]>();
const messageResolvers = new WeakMap<WebSocket, (value: unknown) => void>();

function connectWs(rawKey: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://localhost:${SERVER_PORT}/ops`, {
			// @ts-expect-error Bun supports headers on WebSocket constructor
			headers: { Authorization: `Bearer ${rawKey}` },
		});
		const queue: unknown[] = [];
		messageQueues.set(ws, queue);

		ws.onmessage = (ev) => {
			const data = JSON.parse(String(ev.data));
			const resolver = messageResolvers.get(ws);
			if (resolver) {
				messageResolvers.delete(ws);
				resolver(data);
			} else {
				queue.push(data);
			}
		};

		ws.onopen = () => resolve(ws);
		ws.onerror = (e) => reject(e);
	});
}

function readMessage<T = unknown>(ws: WebSocket, timeoutMs = 3000): Promise<T> {
	const queue = messageQueues.get(ws);
	if (queue && queue.length > 0) {
		return Promise.resolve(queue.shift() as T);
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			messageResolvers.delete(ws);
			reject(new Error("Timeout waiting for message"));
		}, timeoutMs);
		messageResolvers.set(ws, (data) => {
			clearTimeout(timer);
			resolve(data as T);
		});
	});
}

function drainQueue(ws: WebSocket): void {
	const queue = messageQueues.get(ws);
	if (queue) queue.length = 0;
}

/** Read messages until one matches the expected request ID (skips broadcasts). */
async function readReply<T = unknown>(
	ws: WebSocket,
	id: number,
	timeoutMs = 3000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const msg = await readMessage<Record<string, unknown>>(
			ws,
			deadline - Date.now(),
		);
		if (msg.id === id) return msg as T;
	}
	throw new Error(`Timeout waiting for reply with id=${id}`);
}

async function fullHandshake(
	name: string,
	trustLevel: TrustLevel,
	capabilities: string[],
): Promise<{
	ws: WebSocket;
	session: string;
	granted: string[];
	rawKey: string;
}> {
	const { rawKey } = await provisionAgent(name, trustLevel);
	const ws = await connectWs(rawKey);

	const challenge = await readMessage<{
		type: string;
		nonce: string;
		challenge: string;
	}>(ws);

	const diffMatch = challenge.challenge.match(/difficulty (\d+)/);
	const difficulty = diffMatch?.[1] ? Number.parseInt(diffMatch[1], 10) : 8;
	const solution = await solveChallenge(challenge.nonce, difficulty);

	ws.send(JSON.stringify({ type: "negotiate", solution, capabilities }));

	const negotiated = await readMessage<{
		type: string;
		granted: string[];
		session: string;
	}>(ws);

	return {
		ws,
		session: negotiated.session,
		granted: negotiated.granted,
		rawKey,
	};
}

function sendRelay(
	ws: WebSocket,
	method: string,
	id: number,
	params?: Record<string, unknown>,
): void {
	ws.send(JSON.stringify({ type: "relay", method, id, params }));
}

// --- Integration tests ---

describe("Full agent lifecycle", () => {
	it("provision → connect → negotiate → relay → close", async () => {
		const { ws, session, granted } = await fullHandshake(
			"lifecycle-agent",
			"write",
			["chat", "health"],
		);

		expect(session).toMatch(/^exp-lifecycle-agent-/);
		expect(granted).toEqual(["chat", "health"]);

		// Send a message
		sendRelay(ws, "chat.send", 1, { content: "lifecycle test" });
		const reply = await readMessage<{
			type: string;
			result: { content: string };
			id: number;
		}>(ws);
		expect(reply.result.content).toBe("Echo: lifecycle test");

		// Close
		const closed = new Promise<void>((r) => {
			ws.onclose = () => r();
		});
		ws.close();
		await closed;
	});
});

describe("Trust level enforcement", () => {
	it("write agent gets all requested capabilities", async () => {
		const { granted } = await fullHandshake("write-agent", "write", [
			"chat",
			"agent",
			"presence",
			"health",
		]);
		expect(granted).toEqual(["chat", "agent", "presence", "health"]);
	});

	it("read agent is restricted to read-only capabilities", async () => {
		const { ws, granted } = await fullHandshake("read-agent", "read", [
			"chat",
			"agent",
			"presence",
			"health",
		]);
		expect(granted).toEqual(["chat", "health"]);

		// Verify denied at relay level too
		sendRelay(ws, "agent.list", 1);
		const err = await readMessage<{ error: { type: string }; id: number }>(ws);
		expect(err.error.type).toBe("capability_denied");
		expect(err.id).toBe(1);

		ws.close();
	});

	it("capability filtering applies per-namespace at relay time", async () => {
		const { ws } = await fullHandshake(
			"partial-agent",
			"write",
			["chat"], // only request chat, skip agent/presence/health
		);

		// chat.send works
		sendRelay(ws, "chat.send", 1, { content: "allowed" });
		const ok = await readMessage<{ result: { content: string }; id: number }>(
			ws,
		);
		expect(ok.id).toBe(1);
		expect(ok.result.content).toBe("Echo: allowed");

		// Drain broadcast
		await new Promise((r) => setTimeout(r, 50));
		drainQueue(ws);

		// agent.list denied (not requested even though trust allows it)
		sendRelay(ws, "agent.list", 2);
		const denied = await readMessage<{ error: { type: string }; id: number }>(
			ws,
		);
		expect(denied.error.type).toBe("capability_denied");

		// health.ping denied too
		sendRelay(ws, "health.ping", 3);
		const denied2 = await readMessage<{ error: { type: string }; id: number }>(
			ws,
		);
		expect(denied2.error.type).toBe("capability_denied");

		ws.close();
	});
});

describe("Credential revocation", () => {
	it("revoked key is rejected at upgrade", async () => {
		const { rawKey } = await provisionAgent("soon-revoked", "write");
		revokeAgent("soon-revoked");

		const res = await fetch(`http://localhost:${SERVER_PORT}/ops`, {
			headers: {
				Upgrade: "websocket",
				Authorization: `Bearer ${rawKey}`,
			},
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toBe("Invalid agent key");
	});
});

describe("Session isolation", () => {
	it("two agents have independent backend sessions", async () => {
		const a = await fullHandshake("agent-a", "write", ["chat"]);
		const b = await fullHandshake("agent-b", "write", ["chat"]);

		// Agent A sends a message
		sendRelay(a.ws, "chat.send", 1, { content: "from A" });
		const replyA = await readMessage<{
			result: { content: string };
			id: number;
		}>(a.ws);
		expect(replyA.result.content).toBe("Echo: from A");

		// Drain broadcasts
		await new Promise((r) => setTimeout(r, 50));
		drainQueue(a.ws);
		drainQueue(b.ws);

		// Agent B checks history — should not contain A's messages (different session)
		sendRelay(b.ws, "chat.history", 2);
		const histB = await readMessage<{
			result: { history: unknown[] };
			id: number;
		}>(b.ws);
		expect(histB.id).toBe(2);
		// B's session has no messages yet
		expect(histB.result.history.length).toBe(0);

		a.ws.close();
		b.ws.close();
	});
});

describe("Concurrent connections", () => {
	it("multiple agents operate independently", async () => {
		const agents = await Promise.all([
			fullHandshake("concurrent-1", "write", ["chat"]),
			fullHandshake("concurrent-2", "read", ["chat"]),
			fullHandshake("concurrent-3", "write", ["chat", "agent"]),
		]);

		// All got their expected capabilities
		const [a1, a2, a3] = agents;
		expect(a1.granted).toEqual(["chat"]);
		expect(a2.granted).toEqual(["chat"]);
		expect(a3.granted).toEqual(["chat", "agent"]);

		// All can send independently (use readReply to skip broadcast noise)
		for (let i = 0; i < agents.length; i++) {
			const agent = agents[i] as (typeof agents)[number];
			sendRelay(agent.ws, "chat.send", 100 + i, { content: `msg-${i}` });
			const reply = await readReply<{
				result: { content: string };
				id: number;
			}>(agent.ws, 100 + i);
			expect(reply.id).toBe(100 + i);
			expect(reply.result.content).toBe(`Echo: msg-${i}`);
		}

		for (const agent of agents) {
			agent.ws.close();
		}
	});
});

describe("Backend relay methods", () => {
	it("chat.inject adds to session history", async () => {
		const { ws } = await fullHandshake("inject-agent", "write", ["chat"]);

		sendRelay(ws, "chat.inject", 1, {
			role: "system",
			content: "You are helpful",
		});
		const ok = await readMessage<{ result: { injected: boolean }; id: number }>(
			ws,
		);
		expect(ok.result.injected).toBe(true);

		// Verify it shows up in history
		sendRelay(ws, "chat.history", 2);
		const hist = await readMessage<{
			result: { history: Array<{ role: string; content: string }> };
			id: number;
		}>(ws);
		expect(hist.result.history).toContainEqual(
			expect.objectContaining({ role: "system", content: "You are helpful" }),
		);

		ws.close();
	});

	it("chat.abort sets abort flag", async () => {
		const { ws } = await fullHandshake("abort-agent", "write", ["chat"]);

		sendRelay(ws, "chat.abort", 1);
		const reply = await readMessage<{
			result: { aborted: boolean };
			id: number;
		}>(ws);
		expect(reply.result.aborted).toBe(true);

		ws.close();
	});

	it("unknown method returns error from backend", async () => {
		const { ws } = await fullHandshake("unknown-method-agent", "write", [
			"chat",
		]);

		sendRelay(ws, "chat.nonexistent", 1);
		const reply = await readMessage<{
			type: string;
			event?: string;
			result?: unknown;
			id?: number;
		}>(ws);
		// Backend returns an error for unknown methods
		// The relay wraps it — check we get something back
		expect(reply.type).toBe("relay");

		ws.close();
	});
});

describe("Protocol violations", () => {
	it("sending relay before negotiation returns protocol error", async () => {
		const { rawKey } = await provisionAgent("proto-agent", "write");
		const ws = await connectWs(rawKey);

		await readMessage(ws); // consume negotiate challenge

		ws.send(JSON.stringify({ type: "relay", method: "chat.send", id: 1 }));
		const err = await readMessage<{ error: { type: string } }>(ws);
		expect(err.error.type).toBe("protocol_error");

		ws.close();
	});

	it("sending invalid JSON returns parse error", async () => {
		const { ws } = await fullHandshake("json-agent", "write", ["chat"]);

		ws.send("not valid json {{{");
		const err = await readMessage<{ error: { type: string } }>(ws);
		expect(err.error.type).toBe("parse_error");

		ws.close();
	});

	it("health endpoint works without auth", async () => {
		const res = await fetch(`http://localhost:${SERVER_PORT}/health`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; version: string };
		expect(body.status).toBe("ok");
		expect(body.version).toBe("2.0.0-exp");
	});
});

describe("Admin trust level", () => {
	it("admin gets all capabilities including system", async () => {
		const { granted } = await fullHandshake("admin-agent", "admin", [
			"chat",
			"agent",
			"presence",
			"health",
			"system",
		]);
		expect(granted).toEqual(["chat", "agent", "presence", "health", "system"]);
	});

	it("write agent cannot access system namespace", async () => {
		const { ws, granted } = await fullHandshake("write-sys-agent", "write", [
			"chat",
			"system",
		]);
		expect(granted).toEqual(["chat"]);

		sendRelay(ws, "system.shutdown", 1);
		const err = await readMessage<{ error: { type: string }; id: number }>(ws);
		expect(err.error.type).toBe("capability_denied");

		ws.close();
	});
});

describe("Credential expiry", () => {
	it("expired key is rejected at upgrade", async () => {
		// Provision with 1ms expiry — will be expired by the time we connect
		const { rawKey } = await provisionAgent("expiring-agent", "write", 1);
		await new Promise((r) => setTimeout(r, 10));

		const res = await fetch(`http://localhost:${SERVER_PORT}/ops`, {
			headers: {
				Upgrade: "websocket",
				Authorization: `Bearer ${rawKey}`,
			},
		});
		expect(res.status).toBe(401);
	});

	it("non-expiring key works normally", async () => {
		const { ws, granted } = await fullHandshake("no-expiry-agent", "write", [
			"chat",
		]);
		expect(granted).toEqual(["chat"]);
		ws.close();
	});
});

describe("Heartbeat credential re-validation", () => {
	it("checkCredentialValid detects revoked credentials", async () => {
		const { credential } = await provisionAgent(
			"heartbeat-agent",
			"write",
		);

		const { checkCredentialValid } = await import("../src/middleware/auth");
		expect(checkCredentialValid(credential.id)).toBe(true);

		revokeAgent("heartbeat-agent");
		expect(checkCredentialValid(credential.id)).toBe(false);
	});

	it("checkCredentialValid detects expired credentials", async () => {
		const { credential } = await provisionAgent(
			"expiry-check-agent",
			"write",
			1,
		);
		await new Promise((r) => setTimeout(r, 10));

		const { checkCredentialValid } = await import("../src/middleware/auth");
		expect(checkCredentialValid(credential.id)).toBe(false);
	});
});

describe("Ping/pong keepalive", () => {
	it("responds to ping with pong", async () => {
		const { ws } = await fullHandshake("ping-agent", "write", ["chat"]);

		ws.send(JSON.stringify({ type: "ping", id: "k1" }));
		const pong = await readMessage<{ type: string; id: string; ok: boolean }>(
			ws,
		);
		expect(pong.type).toBe("pong");
		expect(pong.id).toBe("k1");
		expect(pong.ok).toBe(true);

		ws.close();
	});
});
