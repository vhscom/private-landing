/**
 * @file handler.test.ts
 * Unit tests for the control bridge WebSocket handler.
 *
 * @license Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	_resetActiveConnections,
	createBridgeHandler,
} from "../src/bridge/handler";
import {
	_resetSeenNonces,
	checkLeadingZeroBits,
	solveChallenge,
} from "../src/bridge/pow";
import type { BridgePrincipal } from "../src/bridge/types";
import { CloseCodes } from "../src/bridge/types";
import type { ControlBindings } from "../src/types";

afterEach(() => {
	_resetActiveConnections();
	_resetSeenNonces();
});

const mockEnv = {
	AUTH_DB_URL: "libsql://test",
	JWT_ACCESS_SECRET: "test-access",
	JWT_REFRESH_SECRET: "test-refresh",
	GATEWAY_URL: "ws://localhost:18789",
	GATEWAY_TOKEN: "test-token",
} as ControlBindings;

function makePrincipal(uid = 1): BridgePrincipal {
	return {
		id: `user:${uid}`,
		name: `user-${uid}`,
		trustLevel: "admin",
		uid,
		sid: "test-session-id",
	};
}

function makeDeps(overrides?: Partial<ControlBindings>) {
	return {
		env: { ...mockEnv, ...overrides },
		ipAddress: "127.0.0.1",
		ua: "test-agent",
	};
}

/** Minimal WSContext mock for unit tests. */
function createMockWs() {
	const sent: string[] = [];
	let closed = false;
	let closeCode = 0;
	let closeReason = "";

	return {
		ws: {
			send: (data: string) => {
				sent.push(data);
			},
			close: (code?: number, reason?: string) => {
				closed = true;
				closeCode = code ?? 0;
				closeReason = reason ?? "";
			},
		},
		sent,
		get closed() {
			return closed;
		},
		get closeCode() {
			return closeCode;
		},
		get closeReason() {
			return closeReason;
		},
		lastMessage<T>(): T {
			return JSON.parse(sent[sent.length - 1]!) as T;
		},
	};
}

// --- PoW utilities ---

describe("checkLeadingZeroBits", () => {
	it("returns true for all-zero hash with difficulty 0", () => {
		expect(checkLeadingZeroBits(new Uint8Array(32), 0)).toBe(true);
	});

	it("returns true for all-zero hash with difficulty 8", () => {
		expect(checkLeadingZeroBits(new Uint8Array(32), 8)).toBe(true);
	});

	it("returns false when first byte is non-zero at difficulty 8", () => {
		const hash = new Uint8Array(32);
		hash[0] = 1;
		expect(checkLeadingZeroBits(hash, 8)).toBe(false);
	});

	it("handles partial byte checks", () => {
		const hash = new Uint8Array(32);
		hash[0] = 0;
		hash[1] = 0b00001111; // 4 leading zeros in byte 1
		expect(checkLeadingZeroBits(hash, 12)).toBe(true);
		expect(checkLeadingZeroBits(hash, 13)).toBe(false);
	});
});

describe("solveChallenge", () => {
	it("produces a valid solution", async () => {
		const nonce = btoa("test-nonce-data");
		const solution = await solveChallenge(nonce, 4); // low difficulty for speed
		const input = new TextEncoder().encode(nonce + solution);
		const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
		expect(checkLeadingZeroBits(hash, 4)).toBe(true);
	});
});

// --- Handler lifecycle ---

describe("createBridgeHandler", () => {
	it("sends PoW challenge on open", () => {
		const handler = createBridgeHandler(makePrincipal(), makeDeps());
		const mock = createMockWs();

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		handler.onOpen?.(new Event("open"), mock.ws as any);

		const msg = mock.lastMessage<{ type: string; nonce: string }>();
		expect(msg.type).toBe("negotiate");
		expect(msg.nonce).toBeDefined();
		expect(typeof msg.nonce).toBe("string");
	});

	it("closes with NEGOTIATION_TIMEOUT on timeout", async () => {
		vi.useFakeTimers();
		const handler = createBridgeHandler(makePrincipal(), makeDeps());
		const mock = createMockWs();

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		handler.onOpen?.(new Event("open"), mock.ws as any);

		vi.advanceTimersByTime(6000); // > 5s negotiation timeout
		expect(mock.closed).toBe(true);
		expect(mock.closeCode).toBe(CloseCodes.NEGOTIATION_TIMEOUT);

		vi.useRealTimers();
	});

	it("rejects invalid PoW solution", async () => {
		const handler = createBridgeHandler(makePrincipal(), makeDeps());
		const mock = createMockWs();

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		handler.onOpen?.(new Event("open"), mock.ws as any);

		const msgEvent = new MessageEvent("message", {
			data: JSON.stringify({
				type: "negotiate",
				solution: "wrong-solution",
				capabilities: ["chat"],
			}),
		});

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		handler.onMessage?.(msgEvent, mock.ws as any);
		// Wait for async PoW verification to complete
		await new Promise((r) => setTimeout(r, 50));

		expect(mock.closed).toBe(true);
		expect(mock.closeCode).toBe(CloseCodes.INVALID_POW);
	});

	it("rejects parse errors", async () => {
		const handler = createBridgeHandler(makePrincipal(), makeDeps());
		const mock = createMockWs();

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		handler.onOpen?.(new Event("open"), mock.ws as any);

		const msgEvent = new MessageEvent("message", {
			data: "not json",
		});

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		await handler.onMessage?.(msgEvent, mock.ws as any);

		const err = mock.lastMessage<{ error: { type: string } }>();
		expect(err.error.type).toBe("parse_error");
	});

	it("rejects messages with invalid schema", async () => {
		const handler = createBridgeHandler(makePrincipal(), makeDeps());
		const mock = createMockWs();

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		handler.onOpen?.(new Event("open"), mock.ws as any);

		const msgEvent = new MessageEvent("message", {
			data: JSON.stringify({ type: "negotiate", solution: 123 }),
		});

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		await handler.onMessage?.(msgEvent, mock.ws as any);

		const err = mock.lastMessage<{ error: { type: string } }>();
		expect(err.error.type).toBe("protocol_error");
	});

	it("rejects unexpected message type during negotiation", async () => {
		const handler = createBridgeHandler(makePrincipal(), makeDeps());
		const mock = createMockWs();

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		handler.onOpen?.(new Event("open"), mock.ws as any);

		const msgEvent = new MessageEvent("message", {
			data: JSON.stringify({ type: "relay", method: "chat.send" }),
		});

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		await handler.onMessage?.(msgEvent, mock.ws as any);

		const err = mock.lastMessage<{ error: { type: string } }>();
		expect(err.error.type).toBe("protocol_error");
	});

	it("handles oversized messages", async () => {
		const handler = createBridgeHandler(makePrincipal(), makeDeps());
		const mock = createMockWs();

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		handler.onOpen?.(new Event("open"), mock.ws as any);

		const bigMessage = "x".repeat(1024 * 1024 + 1);
		const msgEvent = new MessageEvent("message", { data: bigMessage });

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		await handler.onMessage?.(msgEvent, mock.ws as any);

		const err = mock.lastMessage<{ error: { type: string } }>();
		expect(err.error.type).toBe("message_too_large");
	});
});

// --- Concurrent connection limit ---

describe("concurrent connection limit", () => {
	it("supersedes old connection when new one opens for same user", () => {
		const deps = makeDeps();

		const handler1 = createBridgeHandler(makePrincipal(1), deps);
		const mock1 = createMockWs();
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		handler1.onOpen?.(new Event("open"), mock1.ws as any);
		expect(mock1.closed).toBe(false);

		const handler2 = createBridgeHandler(makePrincipal(1), deps);
		const mock2 = createMockWs();
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		handler2.onOpen?.(new Event("open"), mock2.ws as any);

		// First connection should be closed with superseded code
		expect(mock1.closed).toBe(true);
		expect(mock1.closeCode).toBe(CloseCodes.SUPERSEDED);
		// Second connection should remain open
		expect(mock2.closed).toBe(false);
	});

	it("does not supersede connections for different users", () => {
		const deps = makeDeps();

		const handler1 = createBridgeHandler(makePrincipal(1), deps);
		const mock1 = createMockWs();
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		handler1.onOpen?.(new Event("open"), mock1.ws as any);

		const handler2 = createBridgeHandler(makePrincipal(2), deps);
		const mock2 = createMockWs();
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		handler2.onOpen?.(new Event("open"), mock2.ws as any);

		expect(mock1.closed).toBe(false);
		expect(mock2.closed).toBe(false);
	});
});

// --- Rate limiting ---

describe("message rate limiting", () => {
	it("closes connection after exceeding rate limit", async () => {
		const handler = createBridgeHandler(makePrincipal(), makeDeps());
		const mock = createMockWs();

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		handler.onOpen?.(new Event("open"), mock.ws as any);

		// Send messages exceeding the rate limit (10 per second + the negotiate challenge response)
		for (let i = 0; i <= 11; i++) {
			const msgEvent = new MessageEvent("message", {
				data: JSON.stringify({
					type: "negotiate",
					solution: "x",
					capabilities: ["chat"],
				}),
			});
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			await handler.onMessage?.(msgEvent, mock.ws as any);
		}

		expect(mock.closed).toBe(true);
		expect(mock.closeCode).toBe(CloseCodes.RATE_LIMITED);
	});
});
