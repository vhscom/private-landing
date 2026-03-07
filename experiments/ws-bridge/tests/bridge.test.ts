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
import { _clearCredentials, provisionAgent } from "../src/middleware/auth";
import type { TrustLevel } from "../src/types";

const MOCK_PORT = 19790;
const SERVER_PORT = 19800;

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
	_clearCredentials();
});

// Buffer messages per WebSocket so we never miss early server messages
const messageQueues = new WeakMap<WebSocket, unknown[]>();
const messageResolvers = new WeakMap<WebSocket, (value: unknown) => void>();

/** Provision an agent and connect with its key */
async function connectAgent(
	name: string,
	trustLevel: TrustLevel,
): Promise<{ ws: WebSocket; rawKey: string }> {
	const { rawKey } = await provisionAgent(name, trustLevel);
	const ws = await connectWs(rawKey);
	return { ws, rawKey };
}

/** Connect a WebSocket with an agent key, buffering messages from the start */
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

/** Read one parsed message from the buffer or wait for the next one */
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

/** Full negotiate handshake, returns the WebSocket and session info */
async function negotiateConnection(
	trustLevel: TrustLevel = "write",
	capabilities: string[] = ["chat", "agent", "presence", "health"],
) {
	const { ws, rawKey } = await connectAgent("test-agent", trustLevel);

	const challenge = await readMessage<{
		type: string;
		nonce: string;
		challenge: string;
	}>(ws);
	expect(challenge.type).toBe("negotiate");

	const diffMatch = challenge.challenge.match(/difficulty (\d+)/);
	const difficulty = diffMatch?.[1] ? Number.parseInt(diffMatch[1], 10) : 8;

	const solution = await solveChallenge(challenge.nonce, difficulty);

	ws.send(JSON.stringify({ type: "negotiate", solution, capabilities }));

	const negotiated = await readMessage<{
		type: string;
		granted: string[];
		session: string;
	}>(ws);

	return { ws, negotiated, rawKey };
}

// --- Tests ---

describe("Authentication", () => {
	it("rejects connection without token", async () => {
		const res = await fetch(`http://localhost:${SERVER_PORT}/ops`, {
			headers: { Upgrade: "websocket" },
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: { type: string } };
		expect(body.error.type).toBe("unauthorized");
	});

	it("rejects connection with invalid agent key", async () => {
		const res = await fetch(`http://localhost:${SERVER_PORT}/ops`, {
			headers: {
				Upgrade: "websocket",
				Authorization:
					"Bearer deadbeef0000000000000000000000000000000000000000000000000000cafe",
			},
		});
		expect(res.status).toBe(401);
	});

	it("rejects revoked agent key", async () => {
		const { rawKey } = await provisionAgent("revoked-agent", "read");
		// Revoke it
		const { revokeAgent } = await import("../src/middleware/auth");
		revokeAgent("revoked-agent");

		const res = await fetch(`http://localhost:${SERVER_PORT}/ops`, {
			headers: {
				Upgrade: "websocket",
				Authorization: `Bearer ${rawKey}`,
			},
		});
		expect(res.status).toBe(401);
	});

	it("accepts valid agent key and sends negotiate challenge", async () => {
		const { ws } = await connectAgent("valid-agent", "write");

		const msg = await readMessage<{ type: string; nonce: string }>(ws);
		expect(msg.type).toBe("negotiate");
		expect(msg.nonce).toBeTruthy();

		ws.close();
	});
});

describe("Negotiation", () => {
	it("succeeds with valid PoW and grants capabilities", async () => {
		const { ws, negotiated } = await negotiateConnection("write", [
			"chat",
			"health",
		]);

		expect(negotiated.type).toBe("negotiated");
		expect(negotiated.granted).toContain("chat");
		expect(negotiated.granted).toContain("health");
		expect(negotiated.sessionKey).toBe("agent:test-agent:main");

		ws.close();
	});

	it("restricts capabilities based on trust level", async () => {
		const { ws, negotiated } = await negotiateConnection("read", [
			"chat",
			"agent",
			"presence",
			"health",
		]);

		// read trust only gets chat and health
		expect(negotiated.granted).toContain("chat");
		expect(negotiated.granted).toContain("health");
		expect(negotiated.granted).not.toContain("agent");
		expect(negotiated.granted).not.toContain("presence");

		ws.close();
	});

	it("fails with invalid PoW solution", async () => {
		const { ws } = await connectAgent("pow-fail-agent", "write");

		const challenge = await readMessage<{ type: string; nonce: string }>(ws);
		expect(challenge.type).toBe("negotiate");

		ws.send(
			JSON.stringify({
				type: "negotiate",
				solution: "definitely-wrong",
				capabilities: ["chat"],
			}),
		);

		const err = await readMessage<{ error: { type: string } }>(ws);
		expect(err.error.type).toBe("negotiation_failed");

		await new Promise<void>((resolve) => {
			ws.onclose = () => resolve();
			setTimeout(resolve, 1000);
		});
	});

	it("fails when no requested capabilities match trust level", async () => {
		const { ws } = await connectAgent("no-cap-agent", "read");

		const challenge = await readMessage<{
			type: string;
			nonce: string;
			challenge: string;
		}>(ws);

		const solution = await solveChallenge(challenge.nonce, 8);

		// Request only "agent" which read trust doesn't have
		ws.send(
			JSON.stringify({
				type: "negotiate",
				solution,
				capabilities: ["agent"],
			}),
		);

		const err = await readMessage<{ error: { type: string } }>(ws);
		expect(err.error.type).toBe("negotiation_failed");
	});
});

describe("Capability filtering", () => {
	it("allows relay for granted capabilities", async () => {
		const { ws } = await negotiateConnection("write", ["chat"]);

		ws.send(
			JSON.stringify({
				type: "relay",
				method: "chat.send",
				params: { content: "hello" },
				id: 1,
			}),
		);

		const reply = await readMessage<{
			type: string;
			result: { content: string };
		}>(ws);
		expect(reply.type).toBe("relay");
		expect(reply.result.content).toContain("hello");

		ws.close();
	});

	it("denies relay for non-granted capabilities", async () => {
		const { ws } = await negotiateConnection("read", ["chat"]);

		// read trust doesn't have "agent" capability
		ws.send(
			JSON.stringify({
				type: "relay",
				method: "agent.list",
				id: 2,
			}),
		);

		const reply = await readMessage<{
			error: { type: string; message: string };
			id: number;
		}>(ws);
		expect(reply.error.type).toBe("capability_denied");
		expect(reply.id).toBe(2);

		ws.close();
	});
});

describe("Relay roundtrip", () => {
	it("relays chat.send and receives response from backend", async () => {
		const { ws } = await negotiateConnection("write", ["chat"]);

		ws.send(
			JSON.stringify({
				type: "relay",
				method: "chat.send",
				params: { content: "ping" },
				id: 10,
			}),
		);

		const reply = await readMessage<{
			type: string;
			result: { content: string };
			id: number;
		}>(ws);
		expect(reply.type).toBe("relay");
		expect(reply.id).toBe(10);
		expect(reply.result.content).toBe("Echo: ping");

		ws.close();
	});

	it("relays chat.history", async () => {
		const { ws } = await negotiateConnection("write", ["chat"]);

		ws.send(
			JSON.stringify({
				type: "relay",
				method: "chat.send",
				params: { content: "test-msg" },
				id: 20,
			}),
		);
		await readMessage(ws); // consume send response
		// Drain any broadcast events
		await new Promise((r) => setTimeout(r, 100));
		const queue = messageQueues.get(ws);
		if (queue) queue.length = 0;

		ws.send(
			JSON.stringify({
				type: "relay",
				method: "chat.history",
				id: 21,
			}),
		);

		const history = await readMessage<{
			type: string;
			result: { history: Array<{ content: string }> };
			id: number;
		}>(ws);
		expect(history.id).toBe(21);
		expect(history.result.history.length).toBeGreaterThanOrEqual(2);

		ws.close();
	});

	it("relays chat.abort", async () => {
		const { ws } = await negotiateConnection("write", ["chat"]);

		ws.send(
			JSON.stringify({
				type: "relay",
				method: "chat.abort",
				id: 30,
			}),
		);

		const reply = await readMessage<{
			result: { aborted: boolean };
			id: number;
		}>(ws);
		expect(reply.id).toBe(30);
		expect(reply.result.aborted).toBe(true);

		ws.close();
	});
});

describe("Connection closure", () => {
	it("client-initiated close cleans up connection", async () => {
		const { ws } = await negotiateConnection("write", ["chat"]);

		const closed = new Promise<void>((resolve) => {
			ws.onclose = () => resolve();
		});

		ws.close();
		await closed;

		await new Promise((r) => setTimeout(r, 100));
	});

	it("rejects messages before negotiation completes", async () => {
		const { ws } = await connectAgent("premature-agent", "write");

		await readMessage(ws);

		ws.send(
			JSON.stringify({
				type: "relay",
				method: "chat.send",
				params: { content: "premature" },
			}),
		);

		const err = await readMessage<{ error: { type: string } }>(ws);
		expect(err.error.type).toBe("protocol_error");

		ws.close();
	});
});
