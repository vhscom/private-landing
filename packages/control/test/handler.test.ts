/**
 * @file handler.test.ts
 * Unit tests for the control WebSocket proxy handler.
 *
 * @license Apache-2.0
 */

import "../../observability/test/ws/polyfills";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProxyHandlerDeps } from "../src/bridge/handler";
import {
	_resetActiveConnections,
	createProxyHandler,
} from "../src/bridge/handler";
import type { BridgePrincipal } from "../src/bridge/types";
import { CloseCodes } from "../src/bridge/types";
import type { ControlBindings } from "../src/types";

// Mock createDbClient for session validity tests
vi.mock("@private-landing/infrastructure", () => ({
	createDbClient: vi.fn(),
}));

import { createDbClient } from "@private-landing/infrastructure";

afterEach(() => {
	_resetActiveConnections();
	vi.restoreAllMocks();
});

const mockEnv = {
	AUTH_DB_URL: "libsql://test",
	JWT_ACCESS_SECRET: "test-access",
	JWT_REFRESH_SECRET: "test-refresh",
	GATEWAY_URL: "http://localhost:18789",
	GATEWAY_TOKEN: "test-token",
} as ControlBindings;

function makePrincipal(uid = 1): BridgePrincipal {
	return {
		id: `user:${uid}`,
		name: `user-${uid}`,
		uid,
		sid: "test-session-id",
	};
}

function makeDeps(
	overrides?: Partial<ControlBindings>,
	extra?: Partial<ProxyHandlerDeps>,
): ProxyHandlerDeps {
	return {
		env: { ...mockEnv, ...overrides },
		ipAddress: "127.0.0.1",
		ua: "test-agent",
		...extra,
	};
}

/** Flush microtasks so async connectBackend → .then() chains resolve. */
async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** Minimal WSContext mock for unit tests. */
function createMockWs() {
	const sent: string[] = [];
	const closeCodes: number[] = [];
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
				closeCodes.push(closeCode);
			},
		},
		sent,
		closeCodes,
		get closed() {
			return closed;
		},
		get closeCode() {
			return closeCode;
		},
		get closeReason() {
			return closeReason;
		},
	};
}

/** Mock backend WebSocket with controllable event dispatch. */
class MockBackendWs {
	readyState = 0; // CONNECTING
	private listeners = new Map<string, ((...args: unknown[]) => void)[]>();
	sent: string[] = [];
	closed = false;

	addEventListener(type: string, fn: (...args: unknown[]) => void) {
		const list = this.listeners.get(type) ?? [];
		list.push(fn);
		this.listeners.set(type, list);
	}

	send(data: string) {
		this.sent.push(data);
	}

	close() {
		this.closed = true;
	}

	fireOpen() {
		this.readyState = 1;
		for (const fn of this.listeners.get("open") ?? []) fn();
	}

	fireMessage(data: string) {
		for (const fn of this.listeners.get("message") ?? []) fn({ data });
	}

	fireError() {
		for (const fn of this.listeners.get("error") ?? []) fn();
	}

	fireClose() {
		for (const fn of this.listeners.get("close") ?? []) fn();
	}
}

/**
 * Stub globalThis.WebSocket to return a controllable mock.
 * Returns the mock backend and a restore function.
 */
function stubWebSocket(): {
	backend: MockBackendWs;
	restore: () => void;
} {
	const backend = new MockBackendWs();
	const Original = globalThis.WebSocket;
	function MockConstructor() {
		return backend;
	}
	MockConstructor.OPEN = 1;
	MockConstructor.CLOSED = 3;
	MockConstructor.CLOSING = 2;
	MockConstructor.CONNECTING = 0;
	globalThis.WebSocket = MockConstructor as unknown as typeof WebSocket;
	return {
		backend,
		restore: () => {
			globalThis.WebSocket = Original;
		},
	};
}

/** Open a handler with a stubbed backend, flush microtasks, and activate. */
async function openAndActivate(
	deps?: ProxyHandlerDeps,
	principal?: BridgePrincipal,
) {
	const stub = stubWebSocket();
	const handler = createProxyHandler(
		principal ?? makePrincipal(),
		deps ?? makeDeps(),
	);
	const mock = createMockWs();

	// biome-ignore lint/suspicious/noExplicitAny: test mock
	handler.onOpen?.(new Event("open"), mock.ws as any);
	await flush();
	stub.backend.fireOpen();

	return { handler, mock, stub };
}

// --- Handler lifecycle ---

describe("createProxyHandler", () => {
	it("closes with BACKEND_UNAVAILABLE when gateway is unreachable", async () => {
		const handler = createProxyHandler(makePrincipal(), makeDeps());
		const mock = createMockWs();

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		handler.onOpen?.(new Event("open"), mock.ws as any);

		await new Promise((r) => setTimeout(r, 100));

		expect(mock.closed).toBe(true);
		expect(mock.closeCode).toBe(CloseCodes.BACKEND_UNAVAILABLE);
	});

	it("closes with BACKEND_UNAVAILABLE when GATEWAY_URL is missing", () => {
		const handler = createProxyHandler(
			makePrincipal(),
			makeDeps({ GATEWAY_URL: undefined } as Partial<ControlBindings>),
		);
		const mock = createMockWs();

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		handler.onOpen?.(new Event("open"), mock.ws as any);

		expect(mock.closed).toBe(true);
		expect(mock.closeCode).toBe(CloseCodes.BACKEND_UNAVAILABLE);
	});

	it("rejects binary frames", () => {
		const handler = createProxyHandler(makePrincipal(), makeDeps());
		const mock = createMockWs();

		const msgEvent = new MessageEvent("message", {
			data: new ArrayBuffer(8),
		});

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		handler.onMessage?.(msgEvent, mock.ws as any);

		expect(mock.closed).toBe(true);
		expect(mock.closeCode).toBe(1003);
	});

	it("handles oversized messages", () => {
		const handler = createProxyHandler(makePrincipal(), makeDeps());
		const mock = createMockWs();

		const bigMessage = "x".repeat(1024 * 1024 + 1);
		const msgEvent = new MessageEvent("message", { data: bigMessage });

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		handler.onMessage?.(msgEvent, mock.ws as any);

		expect(mock.closed).toBe(true);
		expect(mock.closeCode).toBe(1009);
	});
});

// --- onClose handler ---

describe("onClose", () => {
	it("emits disconnect event and cleans up", () => {
		const emitFn = vi.fn();
		const handler = createProxyHandler(
			makePrincipal(),
			makeDeps(undefined, { obsEmitEvent: emitFn }),
		);
		const mock = createMockWs();

		handler.onClose?.(
			new CloseEvent("close", { code: 1000, reason: "Normal" }),
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			mock.ws as any,
		);

		expect(emitFn).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				type: "control.ws_disconnect",
				detail: expect.objectContaining({ code: 1000, reason: "Normal" }),
			}),
		);

		// Verify emit context header function returns ua for user-agent,
		// undefined for other headers
		const ctx = emitFn.mock.calls[0][0];
		expect(ctx.req.header("user-agent")).toBe("test-agent");
		expect(ctx.req.header("other")).toBeUndefined();
	});
});

// --- Token injection ---

describe("token injection", () => {
	it("does not expose GATEWAY_TOKEN to client", () => {
		const handler = createProxyHandler(makePrincipal(), makeDeps());
		const mock = createMockWs();

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		handler.onOpen?.(new Event("open"), mock.ws as any);

		for (const msg of mock.sent) {
			expect(msg).not.toContain("test-token");
		}
	});

	it("injects token into connect frames sent to backend", async () => {
		const { handler, mock, stub } = await openAndActivate();
		try {
			const connectFrame = JSON.stringify({
				type: "req",
				method: "connect",
				params: { auth: "placeholder" },
			});
			handler.onMessage?.(
				new MessageEvent("message", { data: connectFrame }),
				// biome-ignore lint/suspicious/noExplicitAny: test mock
				mock.ws as any,
			);

			const sent = JSON.parse(stub.backend.sent[stub.backend.sent.length - 1]);
			expect(sent.params.auth).toEqual({ token: "test-token" });
		} finally {
			stub.restore();
		}
	});

	it("passes non-connect frames through unchanged", async () => {
		const { handler, mock, stub } = await openAndActivate();
		try {
			const listFrame = JSON.stringify({ type: "req", method: "list" });
			handler.onMessage?.(
				new MessageEvent("message", { data: listFrame }),
				// biome-ignore lint/suspicious/noExplicitAny: test mock
				mock.ws as any,
			);

			expect(stub.backend.sent[stub.backend.sent.length - 1]).toBe(listFrame);
		} finally {
			stub.restore();
		}
	});

	it("passes connect frames without params unchanged", async () => {
		const { handler, mock, stub } = await openAndActivate();
		try {
			const noParams = JSON.stringify({ type: "req", method: "connect" });
			handler.onMessage?.(
				new MessageEvent("message", { data: noParams }),
				// biome-ignore lint/suspicious/noExplicitAny: test mock
				mock.ws as any,
			);

			expect(stub.backend.sent[stub.backend.sent.length - 1]).toBe(noParams);
		} finally {
			stub.restore();
		}
	});

	it("passes frames through when GATEWAY_TOKEN is unset", async () => {
		const { handler, mock, stub } = await openAndActivate(
			makeDeps({ GATEWAY_TOKEN: undefined } as Partial<ControlBindings>),
		);
		try {
			const connectFrame = JSON.stringify({
				type: "req",
				method: "connect",
				params: { auth: "original" },
			});
			handler.onMessage?.(
				new MessageEvent("message", { data: connectFrame }),
				// biome-ignore lint/suspicious/noExplicitAny: test mock
				mock.ws as any,
			);

			expect(stub.backend.sent[stub.backend.sent.length - 1]).toBe(
				connectFrame,
			);
		} finally {
			stub.restore();
		}
	});

	it("passes invalid JSON through unchanged", async () => {
		const { handler, mock, stub } = await openAndActivate();
		try {
			handler.onMessage?.(
				new MessageEvent("message", { data: "not json{" }),
				// biome-ignore lint/suspicious/noExplicitAny: test mock
				mock.ws as any,
			);

			expect(stub.backend.sent[stub.backend.sent.length - 1]).toBe("not json{");
		} finally {
			stub.restore();
		}
	});
});

// --- Backend connection lifecycle ---

describe("backend connection lifecycle", () => {
	it("relays backend messages to client", async () => {
		const { mock, stub } = await openAndActivate();
		try {
			stub.backend.fireMessage('{"type":"res","data":"hello"}');
			expect(mock.sent).toContain('{"type":"res","data":"hello"}');
		} finally {
			stub.restore();
		}
	});

	it("does not relay messages after connection is closing", async () => {
		const { mock, stub } = await openAndActivate();
		try {
			stub.backend.fireError(); // triggers closeWith → closing = true
			const sentBefore = mock.sent.length;
			stub.backend.fireMessage("late");
			expect(mock.sent.length).toBe(sentBefore);
		} finally {
			stub.restore();
		}
	});

	it("closes client with BACKEND_DISCONNECTED when backend closes", async () => {
		const { mock, stub } = await openAndActivate();
		try {
			stub.backend.fireClose();
			expect(mock.closed).toBe(true);
			expect(mock.closeCode).toBe(CloseCodes.BACKEND_DISCONNECTED);
		} finally {
			stub.restore();
		}
	});

	it("closes client with BACKEND_UNAVAILABLE on backend error", async () => {
		const { mock, stub } = await openAndActivate();
		try {
			stub.backend.fireError();
			expect(mock.closed).toBe(true);
			expect(mock.closeCode).toBe(CloseCodes.BACKEND_UNAVAILABLE);
		} finally {
			stub.restore();
		}
	});

	it("flushes pending messages when backend connects", async () => {
		const stub = stubWebSocket();
		try {
			const handler = createProxyHandler(makePrincipal(), makeDeps());
			const mock = createMockWs();

			// biome-ignore lint/suspicious/noExplicitAny: test mock
			handler.onOpen?.(new Event("open"), mock.ws as any);
			await flush();

			// Send messages while backend is connecting (readyState still 0)
			const msg1 = JSON.stringify({ type: "req", method: "list", id: 1 });
			const msg2 = JSON.stringify({ type: "req", method: "list", id: 2 });
			handler.onMessage?.(
				new MessageEvent("message", { data: msg1 }),
				// biome-ignore lint/suspicious/noExplicitAny: test mock
				mock.ws as any,
			);
			handler.onMessage?.(
				new MessageEvent("message", { data: msg2 }),
				// biome-ignore lint/suspicious/noExplicitAny: test mock
				mock.ws as any,
			);

			// Backend opens — pending messages should flush
			stub.backend.fireOpen();

			expect(stub.backend.sent).toContain(msg1);
			expect(stub.backend.sent).toContain(msg2);
		} finally {
			stub.restore();
		}
	});

	it("closes backend if connection was closed before backend opens", async () => {
		const stub = stubWebSocket();
		try {
			const handler = createProxyHandler(makePrincipal(), makeDeps());
			const mock = createMockWs();

			// biome-ignore lint/suspicious/noExplicitAny: test mock
			handler.onOpen?.(new Event("open"), mock.ws as any);

			// Close client before .then() resolves
			handler.onClose?.(
				new CloseEvent("close", { code: 1000 }),
				// biome-ignore lint/suspicious/noExplicitAny: test mock
				mock.ws as any,
			);

			// Now flush — .then() runs, sees state=closed, closes backend
			await flush();

			expect(stub.backend.closed).toBe(true);
		} finally {
			stub.restore();
		}
	});

	it("emits connect event when backend activates", async () => {
		const emitFn = vi.fn();
		const { stub } = await openAndActivate(
			makeDeps(undefined, { obsEmitEvent: emitFn }),
		);
		try {
			expect(emitFn).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ type: "control.ws_connect" }),
			);
		} finally {
			stub.restore();
		}
	});

	it("closes with BACKEND_UNAVAILABLE on connect timeout", async () => {
		vi.useFakeTimers();
		// Stub WebSocket that never opens (stays CONNECTING)
		const stub = stubWebSocket();
		try {
			const handler = createProxyHandler(makePrincipal(), makeDeps());
			const mock = createMockWs();

			// biome-ignore lint/suspicious/noExplicitAny: test mock
			handler.onOpen?.(new Event("open"), mock.ws as any);
			await flush();

			// Don't call fireOpen — backend hangs in CONNECTING
			// Advance past 5s connect timeout
			vi.advanceTimersByTime(5001);

			expect(mock.closed).toBe(true);
			expect(mock.closeCode).toBe(CloseCodes.BACKEND_UNAVAILABLE);
			expect(mock.closeReason).toBe("Backend timeout");
		} finally {
			stub.restore();
			vi.useRealTimers();
		}
	});

	it("handles WebSocket constructor throwing", async () => {
		const Original = globalThis.WebSocket;
		const MockConstructor = class {
			static OPEN = 1;
			static CLOSED = 3;
			static CLOSING = 2;
			static CONNECTING = 0;
			constructor() {
				throw new Error("WebSocket not available");
			}
		};
		globalThis.WebSocket = MockConstructor as unknown as typeof WebSocket;
		try {
			const handler = createProxyHandler(makePrincipal(), makeDeps());
			const mock = createMockWs();

			// biome-ignore lint/suspicious/noExplicitAny: test mock
			handler.onOpen?.(new Event("open"), mock.ws as any);
			await flush();

			expect(mock.closed).toBe(true);
			expect(mock.closeCode).toBe(CloseCodes.BACKEND_UNAVAILABLE);
		} finally {
			globalThis.WebSocket = Original;
		}
	});

	it("cleans up backend socket on cleanup", async () => {
		const { handler, mock, stub } = await openAndActivate();
		try {
			handler.onClose?.(
				new CloseEvent("close", { code: 1000 }),
				// biome-ignore lint/suspicious/noExplicitAny: test mock
				mock.ws as any,
			);

			expect(stub.backend.closed).toBe(true);
		} finally {
			stub.restore();
		}
	});

	it("cleanup ignores backend close() errors", async () => {
		const { handler, mock, stub } = await openAndActivate();
		try {
			// Make backend.close() throw
			stub.backend.close = () => {
				throw new Error("already closed");
			};

			// Should not throw
			handler.onClose?.(
				new CloseEvent("close", { code: 1000 }),
				// biome-ignore lint/suspicious/noExplicitAny: test mock
				mock.ws as any,
			);
		} finally {
			stub.restore();
		}
	});
});

// --- Origin forwarding ---

describe("origin forwarding", () => {
	it("falls back to standard WebSocket when fetch upgrade fails", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		fetchSpy.mockRejectedValueOnce(new Error("fetch not supported"));

		const stub = stubWebSocket();
		try {
			const handler = createProxyHandler(
				makePrincipal(),
				makeDeps(undefined, { origin: "https://example.com" }),
			);
			const mock = createMockWs();

			// biome-ignore lint/suspicious/noExplicitAny: test mock
			handler.onOpen?.(new Event("open"), mock.ws as any);
			await flush();
			stub.backend.fireOpen();

			expect(mock.closed).toBe(false);
		} finally {
			stub.restore();
			fetchSpy.mockRestore();
		}
	});

	it("falls back when fetch returns no webSocket property", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));

		const stub = stubWebSocket();
		try {
			const handler = createProxyHandler(
				makePrincipal(),
				makeDeps(undefined, { origin: "https://example.com" }),
			);
			const mock = createMockWs();

			// biome-ignore lint/suspicious/noExplicitAny: test mock
			handler.onOpen?.(new Event("open"), mock.ws as any);
			await flush();
			stub.backend.fireOpen();

			expect(mock.closed).toBe(false);
		} finally {
			stub.restore();
			fetchSpy.mockRestore();
		}
	});

	it("uses fetch-based upgrade when webSocket property is present", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const fakeFetchWs = new MockBackendWs();
		fakeFetchWs.readyState = 1; // Already OPEN
		const resp = new Response("", { status: 200 });
		Object.defineProperty(resp, "webSocket", { value: fakeFetchWs });
		fetchSpy.mockResolvedValueOnce(resp);

		// Ensure WebSocket.OPEN is defined (missing in some Node versions)
		const stub = stubWebSocket();
		try {
			const emitFn = vi.fn();
			const handler = createProxyHandler(
				makePrincipal(),
				makeDeps(undefined, {
					origin: "https://example.com",
					obsEmitEvent: emitFn,
				}),
			);
			const mock = createMockWs();

			// biome-ignore lint/suspicious/noExplicitAny: test mock
			handler.onOpen?.(new Event("open"), mock.ws as any);
			// Fetch path has extra async layers (fetch → await → .then)
			await new Promise((r) => setTimeout(r, 200));

			// Should have activated using the fetch-based socket (already OPEN)
			expect(emitFn).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ type: "control.ws_connect" }),
			);

			fakeFetchWs.fireMessage('{"test":"data"}');
			expect(mock.sent).toContain('{"test":"data"}');
		} finally {
			stub.restore();
			fetchSpy.mockRestore();
		}
	});
});

// --- Idle timeout ---

/** Mock createDbClient to return a valid session so heartbeat doesn't interfere. */
function mockValidSession(): void {
	vi.mocked(createDbClient).mockReturnValue({
		execute: vi
			.fn()
			.mockResolvedValue({ rows: [{ expires_at: "2099-01-01" }] }),
		// biome-ignore lint/suspicious/noExplicitAny: test mock
	} as any);
}

describe("idle timeout", () => {
	it("closes connection on idle timeout", async () => {
		vi.useFakeTimers();
		const stub = stubWebSocket();
		// Prevent heartbeat from starting so idle timer fires first
		vi.spyOn(globalThis, "setInterval").mockReturnValue(
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			0 as any,
		);
		try {
			const handler = createProxyHandler(makePrincipal(), makeDeps());
			const mock = createMockWs();

			// biome-ignore lint/suspicious/noExplicitAny: test mock
			handler.onOpen?.(new Event("open"), mock.ws as any);
			await flush();
			stub.backend.fireOpen();

			vi.advanceTimersByTime(30 * 60_000 + 1);

			expect(mock.closed).toBe(true);
			expect(mock.closeCode).toBe(CloseCodes.IDLE_TIMEOUT);
		} finally {
			stub.restore();
			vi.useRealTimers();
		}
	});

	it("keeps connection alive with periodic message activity", async () => {
		vi.useFakeTimers();
		mockValidSession();
		const stub = stubWebSocket();
		try {
			const handler = createProxyHandler(makePrincipal(), makeDeps());
			const mock = createMockWs();

			// biome-ignore lint/suspicious/noExplicitAny: test mock
			handler.onOpen?.(new Event("open"), mock.ws as any);
			await flush();
			stub.backend.fireOpen();

			// Send messages every 80s (under 90s heartbeat timeout)
			// This exercises resetIdleTimer and keeps heartbeat alive
			for (let i = 0; i < 5; i++) {
				await vi.advanceTimersByTimeAsync(80_000);
				handler.onMessage?.(
					new MessageEvent("message", { data: '{"type":"ping"}' }),
					// biome-ignore lint/suspicious/noExplicitAny: test mock
					mock.ws as any,
				);
			}

			// 400s of activity — connection should remain alive
			expect(mock.closed).toBe(false);
		} finally {
			stub.restore();
			vi.useRealTimers();
		}
	});
});

// --- Heartbeat and session validation ---

describe("heartbeat", () => {
	it("closes on ping timeout when no activity", async () => {
		vi.useFakeTimers();
		// Session checks pass — but inactivity triggers ping timeout
		mockValidSession();
		const stub = stubWebSocket();
		try {
			const handler = createProxyHandler(makePrincipal(), makeDeps());
			const mock = createMockWs();

			// biome-ignore lint/suspicious/noExplicitAny: test mock
			handler.onOpen?.(new Event("open"), mock.ws as any);
			await flush();
			stub.backend.fireOpen();

			// Advance past heartbeat timeout (90s) + one more interval (25s)
			// First few heartbeats pass session check but eventually
			// Date.now() - lastActivity exceeds HEARTBEAT_TIMEOUT_MS
			await vi.advanceTimersByTimeAsync(90_001 + 25_000);

			expect(mock.closed).toBe(true);
			expect(mock.closeCode).toBe(CloseCodes.PING_TIMEOUT);
		} finally {
			stub.restore();
			vi.useRealTimers();
		}
	});

	it("closes on session revocation during heartbeat", async () => {
		vi.useFakeTimers();
		const mockExecute = vi.fn().mockResolvedValue({ rows: [] });
		vi.mocked(createDbClient).mockReturnValue({
			execute: mockExecute,
			// biome-ignore lint/suspicious/noExplicitAny: test mock
		} as any);

		const stub = stubWebSocket();
		try {
			const handler = createProxyHandler(makePrincipal(), makeDeps());
			const mock = createMockWs();

			// biome-ignore lint/suspicious/noExplicitAny: test mock
			handler.onOpen?.(new Event("open"), mock.ws as any);
			await flush();
			stub.backend.fireOpen();

			// Keep activity fresh so ping timeout doesn't fire
			handler.onMessage?.(
				new MessageEvent("message", { data: '{"type":"ping"}' }),
				// biome-ignore lint/suspicious/noExplicitAny: test mock
				mock.ws as any,
			);

			await vi.advanceTimersByTimeAsync(25_001);

			expect(mock.closed).toBe(true);
			expect(mock.closeCode).toBe(CloseCodes.SESSION_REVOKED);
		} finally {
			stub.restore();
			vi.useRealTimers();
		}
	});

	it("closes on session check DB error", async () => {
		vi.useFakeTimers();
		vi.mocked(createDbClient).mockReturnValue({
			execute: vi.fn().mockRejectedValue(new Error("DB unavailable")),
			// biome-ignore lint/suspicious/noExplicitAny: test mock
		} as any);

		const stub = stubWebSocket();
		try {
			const handler = createProxyHandler(makePrincipal(), makeDeps());
			const mock = createMockWs();

			// biome-ignore lint/suspicious/noExplicitAny: test mock
			handler.onOpen?.(new Event("open"), mock.ws as any);
			await flush();
			stub.backend.fireOpen();

			// Keep activity fresh
			handler.onMessage?.(
				new MessageEvent("message", { data: '{"type":"ping"}' }),
				// biome-ignore lint/suspicious/noExplicitAny: test mock
				mock.ws as any,
			);

			await vi.advanceTimersByTimeAsync(25_001);

			expect(mock.closed).toBe(true);
			expect(mock.closeCode).toBe(CloseCodes.SESSION_REVOKED);
			expect(mock.closeReason).toBe("Session check unavailable");
		} finally {
			stub.restore();
			vi.useRealTimers();
		}
	});

	it("keeps connection alive when session is valid", async () => {
		vi.useFakeTimers();
		vi.mocked(createDbClient).mockReturnValue({
			execute: vi
				.fn()
				.mockResolvedValue({ rows: [{ expires_at: "2099-01-01" }] }),
			// biome-ignore lint/suspicious/noExplicitAny: test mock
		} as any);

		const stub = stubWebSocket();
		try {
			const handler = createProxyHandler(makePrincipal(), makeDeps());
			const mock = createMockWs();

			// biome-ignore lint/suspicious/noExplicitAny: test mock
			handler.onOpen?.(new Event("open"), mock.ws as any);
			await flush();
			stub.backend.fireOpen();

			// Keep activity fresh
			handler.onMessage?.(
				new MessageEvent("message", { data: '{"type":"ping"}' }),
				// biome-ignore lint/suspicious/noExplicitAny: test mock
				mock.ws as any,
			);

			await vi.advanceTimersByTimeAsync(25_001);

			expect(mock.closeCodes).not.toContain(CloseCodes.SESSION_REVOKED);
		} finally {
			stub.restore();
			vi.useRealTimers();
		}
	});
});

// --- Concurrent connection limit ---

describe("concurrent connection limit", () => {
	it("supersedes old connection when new one opens for same user", () => {
		const deps = makeDeps();

		const handler1 = createProxyHandler(makePrincipal(1), deps);
		const mock1 = createMockWs();
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		handler1.onOpen?.(new Event("open"), mock1.ws as any);

		const handler2 = createProxyHandler(makePrincipal(1), deps);
		const mock2 = createMockWs();
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		handler2.onOpen?.(new Event("open"), mock2.ws as any);

		expect(mock1.closed).toBe(true);
		expect(mock1.closeCodes).toContain(CloseCodes.SUPERSEDED);
	});

	it("handles supersede when old connection close() throws", () => {
		const deps = makeDeps();

		const handler1 = createProxyHandler(makePrincipal(1), deps);
		const mock1 = createMockWs();
		const origClose = mock1.ws.close;
		let throwOnce = true;
		mock1.ws.close = (...args: Parameters<typeof origClose>) => {
			if (throwOnce) {
				throwOnce = false;
				throw new Error("already closed");
			}
			origClose(...args);
		};
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		handler1.onOpen?.(new Event("open"), mock1.ws as any);

		const handler2 = createProxyHandler(makePrincipal(1), deps);
		const mock2 = createMockWs();
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		handler2.onOpen?.(new Event("open"), mock2.ws as any);

		// Supersede should not throw despite old ws.close() throwing
		expect(mock2.closed).toBe(false);
	});

	it("does not supersede connections for different users", () => {
		const deps = makeDeps();

		const handler1 = createProxyHandler(makePrincipal(1), deps);
		const mock1 = createMockWs();
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		handler1.onOpen?.(new Event("open"), mock1.ws as any);

		const handler2 = createProxyHandler(makePrincipal(2), deps);
		const mock2 = createMockWs();
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		handler2.onOpen?.(new Event("open"), mock2.ws as any);

		expect(mock1.closeCode).not.toBe(CloseCodes.SUPERSEDED);
	});
});

// --- Rate limiting ---

describe("pending message buffer", () => {
	it("closes connection when pending buffer overflows", () => {
		vi.useFakeTimers();
		try {
			const handler = createProxyHandler(makePrincipal(), makeDeps());
			const mock = createMockWs();

			// Don't call onOpen — connection stays in "connecting" state
			// Spread messages across rate-limit windows so rate limit doesn't fire first
			for (let i = 0; i <= 20; i++) {
				if (i > 0 && i % 9 === 0) {
					vi.advanceTimersByTime(1001); // advance past 1s rate window
				}
				const msgEvent = new MessageEvent("message", {
					data: JSON.stringify({ type: "req", method: "test", i }),
				});
				// biome-ignore lint/suspicious/noExplicitAny: test mock
				handler.onMessage?.(msgEvent, mock.ws as any);
			}

			expect(mock.closed).toBe(true);
			expect(mock.closeCode).toBe(CloseCodes.RATE_LIMITED);
			expect(mock.closeReason).toBe("Too many pending messages");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("message rate limiting", () => {
	it("closes connection after exceeding rate limit", () => {
		const handler = createProxyHandler(makePrincipal(), makeDeps());
		const mock = createMockWs();

		for (let i = 0; i <= 11; i++) {
			const msgEvent = new MessageEvent("message", {
				data: JSON.stringify({ type: "req", method: "test" }),
			});
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			handler.onMessage?.(msgEvent, mock.ws as any);
		}

		expect(mock.closed).toBe(true);
		expect(mock.closeCode).toBe(CloseCodes.RATE_LIMITED);
	});

	it("resets rate limit counter after window expires", async () => {
		vi.useFakeTimers();
		mockValidSession();
		const stub = stubWebSocket();
		try {
			const handler = createProxyHandler(makePrincipal(), makeDeps());
			const mock = createMockWs();

			// biome-ignore lint/suspicious/noExplicitAny: test mock
			handler.onOpen?.(new Event("open"), mock.ws as any);
			await flush();
			stub.backend.fireOpen();

			// Send 9 messages (under limit of 10)
			for (let i = 0; i < 9; i++) {
				handler.onMessage?.(
					new MessageEvent("message", {
						data: JSON.stringify({ type: "req", method: "test" }),
					}),
					// biome-ignore lint/suspicious/noExplicitAny: test mock
					mock.ws as any,
				);
			}
			expect(mock.closed).toBe(false);

			// Advance past rate limit window (1 second)
			vi.advanceTimersByTime(1001);

			// Send 9 more — should succeed because window reset
			for (let i = 0; i < 9; i++) {
				handler.onMessage?.(
					new MessageEvent("message", {
						data: JSON.stringify({ type: "req", method: "test" }),
					}),
					// biome-ignore lint/suspicious/noExplicitAny: test mock
					mock.ws as any,
				);
			}
			expect(mock.closed).toBe(false);
		} finally {
			stub.restore();
			vi.useRealTimers();
		}
	});
});
