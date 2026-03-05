import "./polyfills";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPrincipal } from "../../src/types";
import type { WsHandlerDeps } from "../../src/ws/handler";
import { CloseCodes } from "../../src/ws/schemas";

const mockExecute = vi.fn();
const mockProcessEvent = vi.fn().mockResolvedValue(undefined);

vi.mock("@private-landing/infrastructure", () => ({
	createDbClient: vi.fn(() => ({ execute: mockExecute })),
}));

vi.mock("../../src/process-event", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../../src/process-event")>();
	return {
		...original,
		processEvent: (...args: unknown[]) => mockProcessEvent(...args),
	};
});

// Import after mocks are registered
const { createWsHandler, _resetSubscriptionCount } = await import(
	"../../src/ws/handler"
);

interface WsResponse {
	type: string;
	ok?: boolean;
	id?: string;
	connection_id?: string;
	agent?: string;
	granted?: string[];
	denied?: { capability: string; reason: string }[];
	error?: { code: string; message: string };
	payload?: Record<string, unknown>;
}

/** Minimal WSContext mock capturing sends and closes. */
function createMockWs() {
	const sent: string[] = [];
	let closed: { code?: number; reason?: string } | null = null;

	return {
		ws: {
			send(data: string) {
				sent.push(data);
			},
			close(code?: number, reason?: string) {
				closed = { code, reason };
			},
			raw: null,
			binaryType: "text" as const,
			readyState: 1 as const,
			url: null,
			protocol: null,
		} as unknown as Parameters<
			ReturnType<typeof createWsHandler>["onMessage"]
		>[1],
		sent,
		get closed() {
			return closed;
		},
		parsed(): WsResponse[] {
			return sent.map((s) => JSON.parse(s) as WsResponse);
		},
	};
}

function makeMessageEvent(data: unknown): MessageEvent {
	return new MessageEvent("message", {
		data: JSON.stringify(data),
	});
}

const readAgent: AgentPrincipal = {
	id: 1,
	name: "reader-bot",
	trustLevel: "read",
};

const writeAgent: AgentPrincipal = {
	id: 2,
	name: "admin-bot",
	trustLevel: "write",
};

const baseDeps: WsHandlerDeps = {
	env: {
		AUTH_DB_URL: "libsql://test.turso.io",
		AUTH_DB_TOKEN: "test-token",
		JWT_ACCESS_SECRET: "test",
		JWT_REFRESH_SECRET: "test",
	} as WsHandlerDeps["env"],
	ipAddress: "192.0.2.1",
	ua: "test-agent/1.0",
};

/** Negotiate capabilities and return a ready handler + mock. */
function negotiatedHandler(
	agent: AgentPrincipal = readAgent,
	capabilities: string[] = [
		"query_events",
		"query_sessions",
		"subscribe_events",
	],
	deps: WsHandlerDeps = baseDeps,
) {
	const handler = createWsHandler(agent, deps);
	const mock = createMockWs();

	handler.onMessage(
		makeMessageEvent({
			type: "capability.request",
			capabilities,
		}),
		mock.ws,
	);

	// Clear negotiation messages
	mock.sent.length = 0;
	return { handler, ...mock };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("createWsHandler", () => {
	describe("capability negotiation", () => {
		it("grants read capabilities to read-trust agent", () => {
			const handler = createWsHandler(readAgent, baseDeps);
			const { ws, parsed } = createMockWs();

			handler.onMessage(
				makeMessageEvent({
					type: "capability.request",
					capabilities: ["query_events", "subscribe_events", "revoke_session"],
				}),
				ws,
			);

			const response = parsed()[0];
			expect(response.type).toBe("capability.granted");
			expect(response.agent).toBe("reader-bot");
			expect(response.connection_id).toBeDefined();
			expect(response.granted).toContain("query_events");
			expect(response.granted).toContain("subscribe_events");
			expect(response.granted).not.toContain("revoke_session");
			expect(response.denied).toEqual([
				{
					capability: "revoke_session",
					reason: "requires write trust level",
				},
			]);
		});

		it("grants all capabilities to write-trust agent", () => {
			const handler = createWsHandler(writeAgent, baseDeps);
			const { ws, parsed } = createMockWs();

			handler.onMessage(
				makeMessageEvent({
					type: "capability.request",
					capabilities: ["query_events", "subscribe_events", "revoke_session"],
				}),
				ws,
			);

			const response = parsed()[0];
			expect(response.type).toBe("capability.granted");
			expect(response.granted).toContain("query_events");
			expect(response.granted).toContain("subscribe_events");
			expect(response.granted).toContain("revoke_session");
			expect(response.denied).toEqual([]);
		});

		it("deduplicates capabilities in request", () => {
			const handler = createWsHandler(readAgent, baseDeps);
			const { ws, parsed } = createMockWs();

			handler.onMessage(
				makeMessageEvent({
					type: "capability.request",
					capabilities: ["query_events", "query_events", "query_events"],
				}),
				ws,
			);

			const response = parsed()[0];
			expect(response.granted).toEqual(["query_events"]);
			expect(response.denied).toEqual([]);
		});

		it("denies unknown capabilities with reason", () => {
			const handler = createWsHandler(readAgent, baseDeps);
			const { ws, parsed } = createMockWs();

			handler.onMessage(
				makeMessageEvent({
					type: "capability.request",
					capabilities: ["query_events", "not_a_capability"],
				}),
				ws,
			);

			const response = parsed()[0];
			expect(response.granted).toContain("query_events");
			expect(response.denied).toContainEqual({
				capability: "not_a_capability",
				reason: "unknown capability",
			});
		});

		it("denies write capabilities for read-trust agent with reason", () => {
			const handler = createWsHandler(readAgent, baseDeps);
			const { ws, parsed } = createMockWs();

			handler.onMessage(
				makeMessageEvent({
					type: "capability.request",
					capabilities: ["revoke_session"],
				}),
				ws,
			);

			const response = parsed()[0];
			expect(response.granted).toEqual([]);
			expect(response.denied).toHaveLength(1);
			expect(response.denied?.[0].reason).toBe("requires write trust level");
		});
	});

	describe("pre-negotiation protocol enforcement", () => {
		it("closes with 4001 when capability.request not received within deadline", () => {
			vi.useFakeTimers();
			const handler = createWsHandler(readAgent, baseDeps);
			const mock = createMockWs();

			// onOpen captures the ws reference (called by router after accept)
			handler.onOpen(new Event("open"), mock.ws);

			// No messages sent — advance past the 5 s deadline
			vi.advanceTimersByTime(5000);

			// Timer closes the connection directly via the captured ws ref
			expect(mock.closed?.code).toBe(CloseCodes.HANDSHAKE_TIMEOUT);
			vi.useRealTimers();
		});

		it("closes with 4002 when ping sent before negotiation", () => {
			const handler = createWsHandler(readAgent, baseDeps);
			const mock = createMockWs();

			handler.onMessage(makeMessageEvent({ type: "ping", id: "1" }), mock.ws);

			expect(mock.closed).not.toBeNull();
			expect(mock.closed?.code).toBe(CloseCodes.PROTOCOL_ERROR);
		});

		it("closes with 4002 on invalid JSON before negotiation", () => {
			const handler = createWsHandler(readAgent, baseDeps);
			const mock = createMockWs();

			handler.onMessage(
				new MessageEvent("message", { data: "not json{" }),
				mock.ws,
			);

			expect(mock.closed).not.toBeNull();
			expect(mock.closed?.code).toBe(CloseCodes.PROTOCOL_ERROR);
		});

		it("closes with 4002 on unknown message type before negotiation", () => {
			const handler = createWsHandler(readAgent, baseDeps);
			const mock = createMockWs();

			handler.onMessage(
				makeMessageEvent({ type: "unknown_type", id: "1" }),
				mock.ws,
			);

			expect(mock.closed).not.toBeNull();
			expect(mock.closed?.code).toBe(CloseCodes.PROTOCOL_ERROR);
		});
	});

	describe("post-negotiation messaging", () => {
		it("responds to ping with pong echoing id", () => {
			const { handler, ws, parsed } = negotiatedHandler();

			handler.onMessage(makeMessageEvent({ type: "ping", id: "test-42" }), ws);

			const response = parsed()[0];
			expect(response.type).toBe("pong");
			expect(response.id).toBe("test-42");
			expect(response.ok).toBe(true);
		});

		it("responds to ping without id", () => {
			const { handler, ws, parsed } = negotiatedHandler();

			handler.onMessage(makeMessageEvent({ type: "ping" }), ws);

			const response = parsed()[0];
			expect(response.type).toBe("pong");
			expect(response.id).toBeUndefined();
			expect(response.ok).toBe(true);
		});

		it("rejects re-negotiation with connection_id and ALREADY_NEGOTIATED", () => {
			const { handler, ws, parsed } = negotiatedHandler();

			handler.onMessage(
				makeMessageEvent({
					type: "capability.request",
					capabilities: ["query_events"],
				}),
				ws,
			);

			const response = parsed()[0];
			expect(response.ok).toBe(false);
			expect(response.error?.code).toBe("ALREADY_NEGOTIATED");
			expect(response.connection_id).toBeDefined();
		});

		it("returns INVALID_PAYLOAD for unparseable post-negotiation message", () => {
			const { handler, ws, parsed } = negotiatedHandler();

			// Send a message with valid type but missing required fields
			handler.onMessage(makeMessageEvent({ type: "query_events" }), ws);

			const response = parsed()[0];
			expect(response.ok).toBe(false);
			expect(response.error?.code).toBe("INVALID_PAYLOAD");
		});
	});

	describe("empty capabilities array", () => {
		it("closes with 4002 when capabilities array is empty", () => {
			const handler = createWsHandler(readAgent, baseDeps);
			const mock = createMockWs();

			handler.onMessage(
				makeMessageEvent({
					type: "capability.request",
					capabilities: [],
				}),
				mock.ws,
			);

			expect(mock.closed).not.toBeNull();
			expect(mock.closed?.code).toBe(CloseCodes.PROTOCOL_ERROR);
		});
	});

	describe("capability gate", () => {
		it("rejects revoke_session when not granted", () => {
			// read agent only gets read capabilities
			const { handler, ws, parsed } = negotiatedHandler(readAgent, [
				"query_events",
			]);

			handler.onMessage(
				makeMessageEvent({
					type: "revoke_session",
					id: "rev-1",
					payload: { scope: "user", target_id: 42 },
				}),
				ws,
			);

			const response = parsed()[0];
			expect(response.ok).toBe(false);
			expect(response.error?.code).toBe("CAPABILITY_NOT_GRANTED");
			expect(response.error?.message).toContain("revoke_session");
		});

		it("rejects unsubscribe_events when subscribe_events not granted", () => {
			const { handler, ws, parsed } = negotiatedHandler(readAgent, [
				"query_events",
			]);

			handler.onMessage(
				makeMessageEvent({ type: "unsubscribe_events", id: "unsub-1" }),
				ws,
			);

			const response = parsed()[0];
			expect(response.ok).toBe(false);
			expect(response.error?.code).toBe("CAPABILITY_NOT_GRANTED");
			expect(response.error?.message).toContain("subscribe_events");
		});

		it("rejects query_sessions when not granted", () => {
			// Only request query_events, not query_sessions
			const { handler, ws, parsed } = negotiatedHandler(readAgent, [
				"query_events",
			]);

			handler.onMessage(
				makeMessageEvent({
					type: "query_sessions",
					id: "sess-1",
					payload: {},
				}),
				ws,
			);

			const response = parsed()[0];
			expect(response.ok).toBe(false);
			expect(response.error?.code).toBe("CAPABILITY_NOT_GRANTED");
		});
	});

	describe("query_events RPC", () => {
		it("returns events from DB", async () => {
			const mockRows = [
				{
					id: 1,
					type: "login.success",
					ip_address: "1.2.3.4",
					user_id: 42,
					detail: null,
					created_at: "2026-03-01T12:00:00Z",
					actor_id: "user:42",
				},
			];
			mockExecute.mockResolvedValueOnce({
				rows: mockRows,
				rowsAffected: 0,
			});

			const { handler, ws, parsed } = negotiatedHandler();

			handler.onMessage(
				makeMessageEvent({
					type: "query_events",
					id: "qe-1",
					payload: { event_type: "login.success" },
				}),
				ws,
			);

			await vi.advanceTimersByTimeAsync(0);

			const response = parsed()[0];
			expect(response.type).toBe("query_events");
			expect(response.id).toBe("qe-1");
			expect(response.ok).toBe(true);
			expect(response.payload?.events).toEqual(mockRows);
			expect(response.payload?.count).toBe(1);
		});

		it("returns INTERNAL_ERROR on DB failure", async () => {
			mockExecute.mockRejectedValueOnce(new Error("DB down"));

			const { handler, ws, parsed } = negotiatedHandler();

			handler.onMessage(
				makeMessageEvent({
					type: "query_events",
					id: "qe-err",
					payload: {},
				}),
				ws,
			);

			await vi.advanceTimersByTimeAsync(0);

			const response = parsed()[0];
			expect(response.type).toBe("query_events");
			expect(response.id).toBe("qe-err");
			expect(response.ok).toBe(false);
			expect(response.error?.code).toBe("INTERNAL_ERROR");
		});

		it("passes filter params (user_id, ip, actor_id) to query", async () => {
			mockExecute.mockResolvedValueOnce({ rows: [], rowsAffected: 0 });

			const { handler, ws, parsed } = negotiatedHandler();

			handler.onMessage(
				makeMessageEvent({
					type: "query_events",
					id: "qe-filters",
					payload: {
						event_type: "login.failure",
						user_id: 42,
						ip: "10.0.0.1",
						actor_id: "agent:test",
					},
				}),
				ws,
			);

			await vi.advanceTimersByTimeAsync(0);

			const response = parsed()[0];
			expect(response.ok).toBe(true);
			// Verify all filters were passed as SQL args
			const callArgs = mockExecute.mock.calls[0][0].args;
			expect(callArgs).toContain("login.failure");
			expect(callArgs).toContain(42);
			expect(callArgs).toContain("10.0.0.1");
			expect(callArgs).toContain("agent:test");
		});

		it("returns aggregate stats when aggregate is true", async () => {
			mockExecute.mockResolvedValueOnce({
				rows: [
					{ type: "login.success", count: 10 },
					{ type: "login.failure", count: 3 },
				],
				rowsAffected: 0,
			});

			const { handler, ws, parsed } = negotiatedHandler();

			handler.onMessage(
				makeMessageEvent({
					type: "query_events",
					id: "qe-agg",
					payload: { aggregate: true },
				}),
				ws,
			);

			await vi.advanceTimersByTimeAsync(0);

			const response = parsed()[0];
			expect(response.type).toBe("query_events");
			expect(response.id).toBe("qe-agg");
			expect(response.ok).toBe(true);
			expect(response.payload?.stats).toEqual({
				"login.success": 10,
				"login.failure": 3,
			});
		});

		it("returns INTERNAL_ERROR on aggregate DB failure", async () => {
			mockExecute.mockRejectedValueOnce(new Error("DB down"));
			const consoleSpy = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});

			const { handler, ws, parsed } = negotiatedHandler();

			handler.onMessage(
				makeMessageEvent({
					type: "query_events",
					id: "qe-agg-err",
					payload: { aggregate: true },
				}),
				ws,
			);

			await vi.advanceTimersByTimeAsync(0);

			const response = parsed()[0];
			expect(response.ok).toBe(false);
			expect(response.error?.code).toBe("INTERNAL_ERROR");
			consoleSpy.mockRestore();
		});
	});

	describe("query_sessions RPC", () => {
		it("returns sessions from DB", async () => {
			const mockRows = [
				{
					id: "sess-abc",
					user_id: 5,
					ip_address: "1.2.3.4",
					user_agent: "test/1.0",
					created_at: "2026-03-01T12:00:00Z",
					expires_at: "2026-03-08T12:00:00Z",
				},
			];
			mockExecute.mockResolvedValueOnce({
				rows: mockRows,
				rowsAffected: 0,
			});

			const { handler, ws, parsed } = negotiatedHandler(readAgent, [
				"query_events",
				"query_sessions",
			]);

			handler.onMessage(
				makeMessageEvent({
					type: "query_sessions",
					id: "qs-1",
					payload: { active: false },
				}),
				ws,
			);

			await vi.advanceTimersByTimeAsync(0);

			const response = parsed()[0];
			expect(response.type).toBe("query_sessions");
			expect(response.id).toBe("qs-1");
			expect(response.ok).toBe(true);
			expect(response.payload?.sessions).toEqual(mockRows);
			expect(response.payload?.count).toBe(1);
		});

		it("passes user_id filter to query", async () => {
			mockExecute.mockResolvedValueOnce({ rows: [], rowsAffected: 0 });

			const { handler, ws, parsed } = negotiatedHandler(readAgent, [
				"query_events",
				"query_sessions",
			]);

			handler.onMessage(
				makeMessageEvent({
					type: "query_sessions",
					id: "qs-uid",
					payload: { user_id: 42 },
				}),
				ws,
			);

			await vi.advanceTimersByTimeAsync(0);

			const response = parsed()[0];
			expect(response.ok).toBe(true);
			const callArgs = mockExecute.mock.calls[0][0].args;
			expect(callArgs).toContain(42);
		});

		it("returns INTERNAL_ERROR on DB failure", async () => {
			mockExecute.mockRejectedValueOnce(new Error("DB down"));
			const consoleSpy = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});

			const { handler, ws, parsed } = negotiatedHandler(readAgent, [
				"query_events",
				"query_sessions",
			]);

			handler.onMessage(
				makeMessageEvent({
					type: "query_sessions",
					id: "qs-err",
					payload: {},
				}),
				ws,
			);

			await vi.advanceTimersByTimeAsync(0);

			const response = parsed()[0];
			expect(response.ok).toBe(false);
			expect(response.error?.code).toBe("INTERNAL_ERROR");
			consoleSpy.mockRestore();
		});
	});

	describe("revoke_session RPC", () => {
		it("revokes sessions by user scope", async () => {
			mockExecute.mockResolvedValueOnce({
				rows: [],
				rowsAffected: 3,
			});

			const { handler, ws, parsed } = negotiatedHandler(writeAgent, [
				"query_events",
				"revoke_session",
			]);

			handler.onMessage(
				makeMessageEvent({
					type: "revoke_session",
					id: "rs-1",
					payload: { scope: "user", target_id: 42 },
				}),
				ws,
			);

			await vi.advanceTimersByTimeAsync(0);

			const response = parsed()[0];
			expect(response.type).toBe("revoke_session");
			expect(response.id).toBe("rs-1");
			expect(response.ok).toBe(true);
			expect(response.payload?.revoked).toBe(3);
		});

		it("revokes a single session by session scope", async () => {
			mockExecute.mockResolvedValueOnce({
				rows: [],
				rowsAffected: 1,
			});

			const { handler, ws, parsed } = negotiatedHandler(writeAgent, [
				"query_events",
				"revoke_session",
			]);

			handler.onMessage(
				makeMessageEvent({
					type: "revoke_session",
					id: "rs-2",
					payload: { scope: "session", target_id: "sess-xyz" },
				}),
				ws,
			);

			await vi.advanceTimersByTimeAsync(0);

			const response = parsed()[0];
			expect(response.ok).toBe(true);
			expect(response.payload?.revoked).toBe(1);
		});

		it("revokes all sessions with scope all", async () => {
			mockExecute.mockResolvedValueOnce({
				rows: [],
				rowsAffected: 15,
			});

			const { handler, ws, parsed } = negotiatedHandler(writeAgent, [
				"query_events",
				"revoke_session",
			]);

			handler.onMessage(
				makeMessageEvent({
					type: "revoke_session",
					id: "rs-all",
					payload: { scope: "all" },
				}),
				ws,
			);

			await vi.advanceTimersByTimeAsync(0);

			const response = parsed()[0];
			expect(response.type).toBe("revoke_session");
			expect(response.id).toBe("rs-all");
			expect(response.ok).toBe(true);
			expect(response.payload?.revoked).toBe(15);
		});

		it("revokes all sessions with cache invalidation", async () => {
			const mockCache = {
				smembers: vi.fn().mockResolvedValue(["sid-1", "sid-2"]),
				del: vi.fn().mockResolvedValue(true),
			};
			const createCacheClient = vi.fn(() => mockCache);

			// First call: collect affected user IDs
			mockExecute
				.mockResolvedValueOnce({
					rows: [{ user_id: 1 }, { user_id: 2 }],
					rowsAffected: 0,
				})
				// Second call: UPDATE sessions
				.mockResolvedValueOnce({
					rows: [],
					rowsAffected: 4,
				});

			const { handler, ws, parsed } = negotiatedHandler(
				writeAgent,
				["revoke_session"],
				{
					...baseDeps,
					createCacheClient,
				},
			);

			handler.onMessage(
				makeMessageEvent({
					type: "revoke_session",
					id: "rs-all-cache",
					payload: { scope: "all" },
				}),
				ws,
			);

			await vi.advanceTimersByTimeAsync(0);

			const response = parsed()[0];
			expect(response.ok).toBe(true);
			expect(response.payload?.revoked).toBe(4);
			expect(createCacheClient).toHaveBeenCalled();
			expect(mockCache.smembers).toHaveBeenCalledTimes(2);
			expect(mockCache.del).toHaveBeenCalled();
		});

		it("returns INTERNAL_ERROR on DB failure", async () => {
			mockExecute.mockRejectedValueOnce(new Error("DB down"));

			const { handler, ws, parsed } = negotiatedHandler(writeAgent, [
				"query_events",
				"revoke_session",
			]);

			handler.onMessage(
				makeMessageEvent({
					type: "revoke_session",
					id: "rs-err",
					payload: { scope: "user", target_id: 42 },
				}),
				ws,
			);

			await vi.advanceTimersByTimeAsync(0);

			const response = parsed()[0];
			expect(response.ok).toBe(false);
			expect(response.error?.code).toBe("INTERNAL_ERROR");
		});

		it("invalidates cache for user scope", async () => {
			const mockCache = {
				smembers: vi.fn().mockResolvedValue(["sid-1"]),
				del: vi.fn().mockResolvedValue(true),
			};
			const createCacheClient = vi.fn(() => mockCache);

			mockExecute.mockResolvedValueOnce({ rows: [], rowsAffected: 2 });

			const { handler, ws, parsed } = negotiatedHandler(
				writeAgent,
				["revoke_session"],
				{
					...baseDeps,
					createCacheClient,
				},
			);

			handler.onMessage(
				makeMessageEvent({
					type: "revoke_session",
					id: "rs-cache-user",
					payload: { scope: "user", target_id: 42 },
				}),
				ws,
			);

			await vi.advanceTimersByTimeAsync(0);

			const response = parsed()[0];
			expect(response.ok).toBe(true);
			expect(mockCache.smembers).toHaveBeenCalledWith("user_sessions:42");
			expect(mockCache.del).toHaveBeenCalledWith("session:sid-1");
			expect(mockCache.del).toHaveBeenCalledWith("user_sessions:42");
		});

		it("invalidates cache for session scope", async () => {
			const mockCache = {
				get: vi.fn().mockResolvedValue(JSON.stringify({ userId: 7 })),
				del: vi.fn().mockResolvedValue(true),
				srem: vi.fn().mockResolvedValue(1),
			};
			const createCacheClient = vi.fn(() => mockCache);

			mockExecute.mockResolvedValueOnce({ rows: [], rowsAffected: 1 });

			const { handler, ws, parsed } = negotiatedHandler(
				writeAgent,
				["revoke_session"],
				{
					...baseDeps,
					createCacheClient,
				},
			);

			handler.onMessage(
				makeMessageEvent({
					type: "revoke_session",
					id: "rs-cache-sess",
					payload: { scope: "session", target_id: "sess-xyz" },
				}),
				ws,
			);

			await vi.advanceTimersByTimeAsync(0);

			const response = parsed()[0];
			expect(response.ok).toBe(true);
			expect(mockCache.get).toHaveBeenCalledWith("session:sess-xyz");
			expect(mockCache.srem).toHaveBeenCalledWith(
				"user_sessions:7",
				"sess-xyz",
			);
			expect(mockCache.del).toHaveBeenCalledWith("session:sess-xyz");
		});

		it("succeeds when cache invalidation fails (best-effort)", async () => {
			const mockCache = {
				smembers: vi.fn().mockRejectedValue(new Error("cache error")),
				del: vi.fn().mockResolvedValue(true),
			};
			const createCacheClient = vi.fn(() => mockCache);
			const consoleSpy = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});

			mockExecute.mockResolvedValueOnce({ rows: [], rowsAffected: 1 });

			const { handler, ws, parsed } = negotiatedHandler(
				writeAgent,
				["revoke_session"],
				{
					...baseDeps,
					createCacheClient,
				},
			);

			handler.onMessage(
				makeMessageEvent({
					type: "revoke_session",
					id: "rs-cache-err",
					payload: { scope: "user", target_id: 42 },
				}),
				ws,
			);

			await vi.advanceTimersByTimeAsync(0);

			const response = parsed()[0];
			expect(response.ok).toBe(true);
			expect(consoleSpy).toHaveBeenCalledWith(
				"[obs] ws cache cleanup error:",
				expect.any(Error),
			);
			consoleSpy.mockRestore();
		});
	});

	describe("subscribe_events RPC", () => {
		it("acknowledges subscription with interval_ms", () => {
			const { handler, ws, parsed } = negotiatedHandler();

			handler.onMessage(
				makeMessageEvent({
					type: "subscribe_events",
					id: "sub-1",
					payload: {},
				}),
				ws,
			);

			const response = parsed()[0];
			expect(response.type).toBe("subscribe_events");
			expect(response.id).toBe("sub-1");
			expect(response.ok).toBe(true);
			expect(response.payload?.interval_ms).toBe(5000);
		});

		it("pushes events on poll interval", async () => {
			const mockRows = [
				{
					id: 1,
					type: "login.success",
					ip_address: "1.2.3.4",
					user_id: 42,
					detail: '{"sessionId":"abc"}',
					created_at: "2026-03-01T12:00:01Z",
					actor_id: "user:42",
				},
			];
			mockExecute.mockResolvedValue({
				rows: mockRows,
				rowsAffected: 0,
			});

			const { handler, ws, sent } = negotiatedHandler();

			handler.onMessage(
				makeMessageEvent({
					type: "subscribe_events",
					id: "sub-2",
					payload: { types: ["login.success"] },
				}),
				ws,
			);

			// Clear ack message
			sent.length = 0;

			// Advance past the poll interval
			await vi.advanceTimersByTimeAsync(5_000);

			const pushed = sent.map((s) => JSON.parse(s) as WsResponse);
			const eventMsg = pushed.find((m) => m.type === "event");
			expect(eventMsg).toBeDefined();
			expect(eventMsg).toEqual({
				type: "event",
				payload: {
					event_id: 1,
					event_type: "login.success",
					ip_address: "1.2.3.4",
					user_id: 42,
					detail: { sessionId: "abc" },
					created_at: "2026-03-01T12:00:01Z",
					actor_id: "user:42",
				},
			});

			// Clean up - unsubscribe
			handler.onMessage(
				makeMessageEvent({
					type: "unsubscribe_events",
					id: "unsub-2",
				}),
				ws,
			);
		});

		it("falls back to raw string when detail is not valid JSON", async () => {
			mockExecute.mockResolvedValue({
				rows: [
					{
						id: 1,
						type: "login.success",
						ip_address: "1.2.3.4",
						user_id: 1,
						detail: "not-json{",
						created_at: "2026-03-01T12:00:01Z",
						actor_id: "user:1",
					},
				],
				rowsAffected: 0,
			});

			const { handler, ws, sent } = negotiatedHandler();

			handler.onMessage(
				makeMessageEvent({
					type: "subscribe_events",
					id: "sub-raw",
					payload: {},
				}),
				ws,
			);
			sent.length = 0;

			await vi.advanceTimersByTimeAsync(5_000);

			const messages = sent.map((s) => JSON.parse(s) as WsResponse);
			const eventMsg = messages.find((m) => m.type === "event");
			expect((eventMsg?.payload as Record<string, unknown>)?.detail).toBe(
				"not-json{",
			);

			handler.onMessage(
				makeMessageEvent({ type: "unsubscribe_events", id: "unsub-raw" }),
				ws,
			);
		});

		it("builds LIKE clause for wildcard type filters", async () => {
			mockExecute.mockResolvedValue({ rows: [], rowsAffected: 0 });

			const { handler, ws, sent } = negotiatedHandler();

			handler.onMessage(
				makeMessageEvent({
					type: "subscribe_events",
					id: "sub-wc",
					payload: { types: ["login.*"] },
				}),
				ws,
			);

			sent.length = 0;
			await vi.advanceTimersByTimeAsync(5_000);

			const call = mockExecute.mock.calls.find(
				(c) =>
					typeof c[0] === "object" &&
					typeof c[0].sql === "string" &&
					c[0].sql.includes("LIKE"),
			);
			expect(call).toBeDefined();
			expect(call?.[0].sql).toContain("type LIKE ?");
			expect(call?.[0].args).toContain("login.%");

			handler.onMessage(
				makeMessageEvent({ type: "unsubscribe_events", id: "unsub-wc" }),
				ws,
			);
		});

		it("combines exact and wildcard type filters", async () => {
			mockExecute.mockResolvedValue({ rows: [], rowsAffected: 0 });

			const { handler, ws, sent } = negotiatedHandler();

			handler.onMessage(
				makeMessageEvent({
					type: "subscribe_events",
					id: "sub-mix",
					payload: { types: ["password.change", "login.*"] },
				}),
				ws,
			);

			sent.length = 0;
			await vi.advanceTimersByTimeAsync(5_000);

			const call = mockExecute.mock.calls.find(
				(c) =>
					typeof c[0] === "object" &&
					typeof c[0].sql === "string" &&
					c[0].sql.includes("LIKE"),
			);
			expect(call).toBeDefined();
			expect(call?.[0].sql).toContain("type IN (?)");
			expect(call?.[0].sql).toContain("type LIKE ?");
			expect(call?.[0].args).toContain("password.change");
			expect(call?.[0].args).toContain("login.%");

			handler.onMessage(
				makeMessageEvent({ type: "unsubscribe_events", id: "unsub-mix" }),
				ws,
			);
		});

		it("updates high water mark after pushing events", async () => {
			const firstBatch = [
				{
					id: 1,
					type: "login.success",
					ip_address: "1.2.3.4",
					user_id: 42,
					detail: null,
					created_at: "2026-03-01T12:00:01Z",
					actor_id: "user:42",
				},
			];

			mockExecute
				// First poll returns events
				.mockResolvedValueOnce({ rows: firstBatch, rowsAffected: 0 })
				// Second poll returns empty (high water mark advanced)
				.mockResolvedValueOnce({ rows: [], rowsAffected: 0 });

			const { handler, ws, sent } = negotiatedHandler();

			handler.onMessage(
				makeMessageEvent({
					type: "subscribe_events",
					id: "sub-hwm",
					payload: {},
				}),
				ws,
			);
			sent.length = 0;

			// First poll
			await vi.advanceTimersByTimeAsync(5_000);
			expect(sent.length).toBeGreaterThan(0);
			sent.length = 0;

			// Second poll — should use updated high water mark
			await vi.advanceTimersByTimeAsync(5_000);

			// Verify the second query used the updated timestamp
			const secondCall =
				mockExecute.mock.calls[mockExecute.mock.calls.length - 1];
			expect(secondCall[0].args[0]).toBe("2026-03-01T12:00:01Z");

			// Clean up
			handler.onMessage(
				makeMessageEvent({ type: "unsubscribe_events", id: "unsub-hwm" }),
				ws,
			);
		});

		it("sends backpressure signal when poll hits limit", async () => {
			const rows = Array.from({ length: 100 }, (_, i) => ({
				id: i + 1,
				type: "login.success",
				ip_address: "1.2.3.4",
				user_id: 1,
				detail: null,
				created_at: `2026-03-01T12:00:${String(i).padStart(2, "0")}Z`,
				actor_id: "user:1",
			}));
			mockExecute.mockResolvedValue({ rows, rowsAffected: 0 });

			const { handler, ws, sent } = negotiatedHandler();

			handler.onMessage(
				makeMessageEvent({
					type: "subscribe_events",
					id: "sub-bp",
					payload: {},
				}),
				ws,
			);
			sent.length = 0;

			await vi.advanceTimersByTimeAsync(5_000);

			const messages = sent.map((s) => JSON.parse(s) as WsResponse);
			const bp = messages.find((m) => m.type === "subscription.backpressure");
			expect(bp).toBeDefined();
			expect(bp).toMatchObject({ count: 100, limit: 100 });

			handler.onMessage(
				makeMessageEvent({ type: "unsubscribe_events", id: "unsub-bp" }),
				ws,
			);
		});

		it("does not send backpressure signal below limit", async () => {
			mockExecute.mockResolvedValue({
				rows: [
					{
						id: 1,
						type: "login.success",
						ip_address: "1.2.3.4",
						user_id: 1,
						detail: null,
						created_at: "2026-03-01T12:00:01Z",
						actor_id: "user:1",
					},
				],
				rowsAffected: 0,
			});

			const { handler, ws, sent } = negotiatedHandler();

			handler.onMessage(
				makeMessageEvent({
					type: "subscribe_events",
					id: "sub-nobp",
					payload: {},
				}),
				ws,
			);
			sent.length = 0;

			await vi.advanceTimersByTimeAsync(5_000);

			const messages = sent.map((s) => JSON.parse(s) as WsResponse);
			expect(
				messages.find((m) => m.type === "subscription.backpressure"),
			).toBeUndefined();

			handler.onMessage(
				makeMessageEvent({ type: "unsubscribe_events", id: "unsub-nobp" }),
				ws,
			);
		});

		it("continues polling after DB error (fail-open)", async () => {
			const consoleSpy = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			mockExecute.mockRejectedValue(new Error("DB poll failed"));

			const { handler, ws, closed } = negotiatedHandler();

			handler.onMessage(
				makeMessageEvent({
					type: "subscribe_events",
					id: "sub-err",
					payload: {},
				}),
				ws,
			);

			// Advance past poll interval — should not crash or close
			await vi.advanceTimersByTimeAsync(5_000);

			expect(closed).toBeNull();
			expect(consoleSpy).toHaveBeenCalledWith(
				"[obs] ws subscription poll failed:",
				expect.any(Error),
			);

			// Clean up
			handler.onMessage(
				makeMessageEvent({ type: "unsubscribe_events", id: "unsub-err" }),
				ws,
			);
			consoleSpy.mockRestore();
		});

		it("returns SUBSCRIPTION_ACTIVE on double subscribe", () => {
			const { handler, ws, sent } = negotiatedHandler();

			handler.onMessage(
				makeMessageEvent({
					type: "subscribe_events",
					id: "sub-first",
					payload: {},
				}),
				ws,
			);

			// Clear first ack
			sent.length = 0;

			handler.onMessage(
				makeMessageEvent({
					type: "subscribe_events",
					id: "sub-second",
					payload: {},
				}),
				ws,
			);

			const response = JSON.parse(sent[0]) as WsResponse;
			expect(response.ok).toBe(false);
			expect(response.error?.code).toBe("SUBSCRIPTION_ACTIVE");

			// Clean up
			handler.onMessage(
				makeMessageEvent({
					type: "unsubscribe_events",
					id: "unsub-cleanup",
				}),
				ws,
			);
		});
	});

	describe("unsubscribe_events RPC", () => {
		it("stops the subscription push", () => {
			const { handler, ws, sent } = negotiatedHandler();

			handler.onMessage(
				makeMessageEvent({
					type: "subscribe_events",
					id: "sub-x",
					payload: {},
				}),
				ws,
			);

			// Clear subscribe ack
			sent.length = 0;

			handler.onMessage(
				makeMessageEvent({
					type: "unsubscribe_events",
					id: "unsub-x",
				}),
				ws,
			);

			const response = JSON.parse(sent[0]) as WsResponse;
			expect(response.type).toBe("unsubscribe_events");
			expect(response.id).toBe("unsub-x");
			expect(response.ok).toBe(true);
		});

		it("succeeds even when no subscription is active", () => {
			const { handler, ws, parsed } = negotiatedHandler();

			handler.onMessage(
				makeMessageEvent({
					type: "unsubscribe_events",
					id: "unsub-noop",
				}),
				ws,
			);

			const response = parsed()[0];
			expect(response.ok).toBe(true);
		});
	});

	describe("onClose", () => {
		it("logs without throwing", () => {
			const handler = createWsHandler(readAgent, baseDeps);
			const { ws } = createMockWs();

			expect(() => {
				handler.onClose(new CloseEvent("close", { code: 1000 }), ws);
			}).not.toThrow();
		});

		it("clears subscription interval on close", () => {
			const { handler, ws } = negotiatedHandler();

			handler.onMessage(
				makeMessageEvent({
					type: "subscribe_events",
					id: "sub-close",
					payload: {},
				}),
				ws,
			);

			// onClose should not throw even with active subscription
			expect(() => {
				handler.onClose(new CloseEvent("close", { code: 1000 }), ws);
			}).not.toThrow();
		});
	});

	describe("DB error keeps connection open", () => {
		it("does not close WebSocket on query failure", async () => {
			mockExecute.mockRejectedValueOnce(new Error("DB unavailable"));

			const ctx = negotiatedHandler();

			ctx.handler.onMessage(
				makeMessageEvent({
					type: "query_events",
					id: "err-open",
					payload: {},
				}),
				ctx.ws,
			);

			await vi.advanceTimersByTimeAsync(0);

			expect(ctx.closed).toBeNull();
			const response = ctx.parsed()[0];
			expect(response.ok).toBe(false);
			expect(response.error?.code).toBe("INTERNAL_ERROR");
		});
	});

	describe("event emission", () => {
		it("emits ws.connect after successful negotiation", () => {
			const handler = createWsHandler(readAgent, baseDeps);
			const { ws } = createMockWs();
			mockProcessEvent.mockClear();

			handler.onMessage(
				makeMessageEvent({
					type: "capability.request",
					capabilities: ["query_events"],
				}),
				ws,
			);

			const calls = mockProcessEvent.mock.calls.map(
				(c) => (c[0] as { type: string }).type,
			);
			expect(calls).toContain("ws.connect");
		});

		it("emits capability.granted and capability.denied events", () => {
			const handler = createWsHandler(readAgent, baseDeps);
			const { ws } = createMockWs();
			mockProcessEvent.mockClear();

			handler.onMessage(
				makeMessageEvent({
					type: "capability.request",
					capabilities: ["query_events", "revoke_session"],
				}),
				ws,
			);

			const events = mockProcessEvent.mock.calls.map(
				(c) => c[0] as { type: string; detail: Record<string, unknown> },
			);

			const grantedEvents = events.filter(
				(e) => e.type === "capability.granted",
			);
			expect(grantedEvents).toHaveLength(1);
			expect(grantedEvents[0].detail.capability).toBe("query_events");

			const deniedEvents = events.filter((e) => e.type === "capability.denied");
			expect(deniedEvents).toHaveLength(1);
			expect(deniedEvents[0].detail.capability).toBe("revoke_session");
			expect(deniedEvents[0].detail.reason).toBe("requires write trust level");
		});

		it("emits ws.unauthorized when capability gate rejects", () => {
			const { handler, ws } = negotiatedHandler(readAgent, ["query_events"]);
			mockProcessEvent.mockClear();

			handler.onMessage(
				makeMessageEvent({
					type: "revoke_session",
					id: "rev-unauth",
					payload: { scope: "user", target_id: 1 },
				}),
				ws,
			);

			const unauthCalls = mockProcessEvent.mock.calls.filter(
				(c) => (c[0] as { type: string }).type === "ws.unauthorized",
			);
			expect(unauthCalls).toHaveLength(1);
			expect(
				(unauthCalls[0][0] as { detail: { type: string } }).detail.type,
			).toBe("revoke_session");
		});

		it("emits ws.disconnect on close", () => {
			const handler = createWsHandler(readAgent, baseDeps);
			const { ws } = createMockWs();
			mockProcessEvent.mockClear();

			handler.onClose(new CloseEvent("close", { code: 1000 }), ws);

			const disconnectCalls = mockProcessEvent.mock.calls.filter(
				(c) => (c[0] as { type: string }).type === "ws.disconnect",
			);
			expect(disconnectCalls).toHaveLength(1);
			expect(
				(disconnectCalls[0][0] as { detail: { code: number } }).detail.code,
			).toBe(1000);
		});

		it("includes connection context in emitted events", () => {
			const handler = createWsHandler(readAgent, baseDeps);
			const { ws } = createMockWs();
			mockProcessEvent.mockClear();

			handler.onMessage(
				makeMessageEvent({
					type: "capability.request",
					capabilities: ["query_events"],
				}),
				ws,
			);

			const connectCall = mockProcessEvent.mock.calls.find(
				(c) => (c[0] as { type: string }).type === "ws.connect",
			);
			expect(connectCall).toBeDefined();
			const event = connectCall?.[0] as {
				ipAddress: string;
				ua: string;
				actorId: string;
				detail: { connectionId: string };
			};
			expect(event.ipAddress).toBe("192.0.2.1");
			expect(event.ua).toBe("test-agent/1.0");
			expect(event.actorId).toBe("agent:reader-bot");
			expect(event.detail.connectionId).toBeDefined();
		});

		it("does not break handler when event emission fails", () => {
			mockProcessEvent.mockRejectedValue(new Error("emit failed"));

			const handler = createWsHandler(readAgent, baseDeps);
			const { ws, parsed } = createMockWs();

			// Negotiation should still succeed despite emission failure
			handler.onMessage(
				makeMessageEvent({
					type: "capability.request",
					capabilities: ["query_events"],
				}),
				ws,
			);

			const response = parsed()[0];
			expect(response.type).toBe("capability.granted");
			expect(response.granted).toContain("query_events");

			// Reset mock for other tests
			mockProcessEvent.mockResolvedValue(undefined);
		});
	});

	describe("per-connection message rate limiting", () => {
		it("closes with RATE_LIMITED (4008) when message rate exceeds limit", () => {
			const handler = createWsHandler(readAgent, baseDeps);
			const mock = createMockWs();

			// Negotiate first
			handler.onMessage(
				makeMessageEvent({
					type: "capability.request",
					capabilities: ["query_events"],
				}),
				mock.ws,
			);

			// Send messages until rate limited (limit is 60/minute, negotiation used 1)
			for (let i = 0; i < 65; i++) {
				if (mock.closed) break;
				handler.onMessage(
					makeMessageEvent({ type: "ping", id: `p-${i}` }),
					mock.ws,
				);
			}

			expect(mock.closed).not.toBeNull();
			expect(mock.closed?.code).toBe(4008);

			const rateLimitEvent = mockProcessEvent.mock.calls.find(
				(c) =>
					(c[0] as { type: string }).type === "rate_limit.reject" &&
					(c[0] as { detail: { limit: string } }).detail.limit === "ws:message",
			);
			expect(rateLimitEvent).toBeDefined();
		});
	});

	describe("credential re-validation", () => {
		/** Advance to the 25s heartbeat interval (credential check + ping). */
		async function advanceToCredentialCheck(): Promise<void> {
			await vi.advanceTimersByTimeAsync(25_000);
		}

		it("closes with 4010 when agent credential is revoked", async () => {
			const handler = createWsHandler(readAgent, baseDeps);
			const mock = createMockWs();

			handler.onMessage(
				makeMessageEvent({
					type: "capability.request",
					capabilities: ["query_events"],
				}),
				mock.ws,
			);
			mock.sent.length = 0;
			mockProcessEvent.mockClear();

			// Credential check query returns revoked credential
			mockExecute.mockResolvedValueOnce({
				rows: [{ revoked_at: "2026-03-01T00:00:00Z" }],
				rowsAffected: 0,
			});

			await advanceToCredentialCheck();

			expect(mock.closed).not.toBeNull();
			expect(mock.closed?.code).toBe(CloseCodes.CREDENTIAL_REVOKED);
			expect(mock.closed?.reason).toBe("Credential revoked");

			const messages = mock.parsed();
			const revokedMsg = messages.find((m) => m.type === "credential.revoked");
			expect(revokedMsg).toBeDefined();
			expect((revokedMsg as Record<string, unknown>).reason).toBe(
				"key_revoked",
			);
			expect((revokedMsg as Record<string, unknown>).guidance).toBe(
				"Re-authenticate with a new agent key",
			);

			const revokedEvent = mockProcessEvent.mock.calls.find(
				(c) => (c[0] as { type: string }).type === "ws.credential_revoked",
			);
			expect(revokedEvent).toBeDefined();
			expect(
				(revokedEvent?.[0] as { detail: { reason: string } }).detail.reason,
			).toBe("key_revoked");

			handler.onClose(new CloseEvent("close", { code: 4010 }), mock.ws);
		});

		it("closes with 4010 when agent credential is deleted", async () => {
			const handler = createWsHandler(readAgent, baseDeps);
			const mock = createMockWs();

			handler.onMessage(
				makeMessageEvent({
					type: "capability.request",
					capabilities: ["query_events"],
				}),
				mock.ws,
			);
			mockProcessEvent.mockClear();

			// Credential check returns no rows (hard-deleted)
			mockExecute.mockResolvedValueOnce({
				rows: [],
				rowsAffected: 0,
			});

			await advanceToCredentialCheck();

			expect(mock.closed).not.toBeNull();
			expect(mock.closed?.code).toBe(CloseCodes.CREDENTIAL_REVOKED);
			expect(mock.closed?.reason).toBe("Credential not found");

			const revokedEvent = mockProcessEvent.mock.calls.find(
				(c) => (c[0] as { type: string }).type === "ws.credential_revoked",
			);
			expect(revokedEvent).toBeDefined();
			expect(
				(revokedEvent?.[0] as { detail: { reason: string } }).detail.reason,
			).toBe("credential_not_found");

			handler.onClose(new CloseEvent("close", { code: 4010 }), mock.ws);
		});

		it("keeps connection alive when credential check fails (fail-open)", async () => {
			const handler = createWsHandler(readAgent, baseDeps);
			const mock = createMockWs();

			handler.onMessage(
				makeMessageEvent({
					type: "capability.request",
					capabilities: ["query_events"],
				}),
				mock.ws,
			);

			// DB error during credential check
			mockExecute.mockRejectedValueOnce(new Error("DB unavailable"));

			await advanceToCredentialCheck();

			// Connection should remain open
			expect(mock.closed).toBeNull();

			handler.onClose(new CloseEvent("close", { code: 1000 }), mock.ws);
		});

		it("closes with 4010 after 3 consecutive credential check failures", async () => {
			const handler = createWsHandler(readAgent, baseDeps);
			const mock = createMockWs();

			handler.onMessage(
				makeMessageEvent({
					type: "capability.request",
					capabilities: ["query_events"],
				}),
				mock.ws,
			);

			// 3 consecutive DB errors
			mockExecute.mockRejectedValueOnce(new Error("DB unavailable"));
			mockExecute.mockRejectedValueOnce(new Error("DB unavailable"));
			mockExecute.mockRejectedValueOnce(new Error("DB unavailable"));

			await advanceToCredentialCheck();
			expect(mock.closed).toBeNull();

			await advanceToCredentialCheck();
			expect(mock.closed).toBeNull();

			await advanceToCredentialCheck();
			expect(mock.closed?.code).toBe(CloseCodes.CREDENTIAL_REVOKED);
			expect(mock.closed?.reason).toBe("Credential check unavailable");

			const revokedEvent = mockProcessEvent.mock.calls.find(
				(c) => (c[0] as { type: string }).type === "ws.credential_revoked",
			);
			expect(revokedEvent).toBeDefined();
			expect(
				(revokedEvent?.[0] as { detail: { reason: string } }).detail.reason,
			).toBe("credential_check_unavailable");
		});

		it("resets failure count after a successful credential check", async () => {
			const handler = createWsHandler(readAgent, baseDeps);
			const mock = createMockWs();

			handler.onMessage(
				makeMessageEvent({
					type: "capability.request",
					capabilities: ["query_events"],
				}),
				mock.ws,
			);

			// 2 failures, then a success, then 2 more failures
			mockExecute.mockRejectedValueOnce(new Error("DB unavailable"));
			mockExecute.mockRejectedValueOnce(new Error("DB unavailable"));
			mockExecute.mockResolvedValueOnce({
				rows: [{ revoked_at: null }],
				rowsAffected: 0,
			});
			mockExecute.mockRejectedValueOnce(new Error("DB unavailable"));
			mockExecute.mockRejectedValueOnce(new Error("DB unavailable"));

			const sendPing = () =>
				handler.onMessage(
					makeMessageEvent({ type: "ping", id: "keepalive" }),
					mock.ws,
				);

			await advanceToCredentialCheck();
			sendPing();
			await advanceToCredentialCheck();
			sendPing();
			await advanceToCredentialCheck(); // success — resets counter
			sendPing();
			await advanceToCredentialCheck();
			sendPing();
			await advanceToCredentialCheck();

			// Still alive — counter reset after the success
			expect(mock.closed).toBeNull();

			handler.onClose(new CloseEvent("close", { code: 1000 }), mock.ws);
		});

		it("keeps connection alive when credential is valid", async () => {
			const handler = createWsHandler(readAgent, baseDeps);
			const mock = createMockWs();

			handler.onMessage(
				makeMessageEvent({
					type: "capability.request",
					capabilities: ["query_events"],
				}),
				mock.ws,
			);

			// Credential check returns valid credential
			mockExecute.mockResolvedValueOnce({
				rows: [{ revoked_at: null }],
				rowsAffected: 0,
			});

			await advanceToCredentialCheck();

			expect(mock.closed).toBeNull();

			handler.onClose(new CloseEvent("close", { code: 1000 }), mock.ws);
		});

		it("emits ws.disconnect with code 4010 on credential revocation", async () => {
			const handler = createWsHandler(readAgent, baseDeps);
			const mock = createMockWs();

			handler.onMessage(
				makeMessageEvent({
					type: "capability.request",
					capabilities: ["query_events"],
				}),
				mock.ws,
			);
			mockProcessEvent.mockClear();

			mockExecute.mockResolvedValueOnce({
				rows: [{ revoked_at: "2026-03-01T00:00:00Z" }],
				rowsAffected: 0,
			});

			await advanceToCredentialCheck();

			handler.onClose(
				new CloseEvent("close", {
					code: 4010,
					reason: "Credential revoked",
				}),
				mock.ws,
			);

			const disconnectCalls = mockProcessEvent.mock.calls.filter(
				(c) => (c[0] as { type: string }).type === "ws.disconnect",
			);
			expect(disconnectCalls).toHaveLength(1);
			expect(
				(disconnectCalls[0][0] as { detail: { code: number } }).detail.code,
			).toBe(4010);
		});
	});

	describe("ping timeout", () => {
		beforeEach(() => {
			// Heartbeat validates credentials before sending ping — return valid
			mockExecute.mockResolvedValue({
				rows: [{ revoked_at: null }],
				rowsAffected: 0,
			});
		});

		it("sends heartbeat with timing and capabilities", async () => {
			const { handler, ws, sent } = negotiatedHandler();

			// Advance past ping interval (25s)
			await vi.advanceTimersByTimeAsync(25_000);

			const messages = sent.map((s) => JSON.parse(s) as WsResponse);
			const hb = messages.find((m) => m.type === "heartbeat") as Record<
				string,
				unknown
			>;
			expect(hb).toBeDefined();
			expect(hb.ts).toBeDefined();
			expect(hb.next_check_ms).toBe(25_000);
			expect(hb.ping_timeout_ms).toBe(90_000);
			expect(hb.capabilities).toEqual(
				expect.arrayContaining([
					"query_events",
					"query_sessions",
					"subscribe_events",
				]),
			);

			handler.onClose(new CloseEvent("close", { code: 1000 }), ws);
		});

		it("closes with 4011 when client silent past ping timeout", async () => {
			const handler = createWsHandler(readAgent, baseDeps);
			const mock = createMockWs();

			handler.onMessage(
				makeMessageEvent({
					type: "capability.request",
					capabilities: ["query_events"],
				}),
				mock.ws,
			);

			// With 25s intervals: callbacks fire at 25, 50, 75, 100s.
			// At 100s: Date.now() - lastClientActivity = 100s > 90s → ping timeout.
			await vi.advanceTimersByTimeAsync(101_000);

			expect(mock.closed).not.toBeNull();
			expect(mock.closed?.code).toBe(CloseCodes.PING_TIMEOUT);
			expect(mock.closed?.reason).toBe("Ping timeout");

			handler.onClose(new CloseEvent("close", { code: 4011 }), mock.ws);
		});

		it("does not kill active clients that send periodic messages", async () => {
			const handler = createWsHandler(readAgent, baseDeps);
			const mock = createMockWs();

			handler.onMessage(
				makeMessageEvent({
					type: "capability.request",
					capabilities: ["query_events"],
				}),
				mock.ws,
			);

			// Send pings every 60s to keep alive — never silent for >90s
			await vi.advanceTimersByTimeAsync(59_000);
			handler.onMessage(
				makeMessageEvent({ type: "ping", id: "keepalive-1" }),
				mock.ws,
			);

			await vi.advanceTimersByTimeAsync(59_000);
			handler.onMessage(
				makeMessageEvent({ type: "ping", id: "keepalive-2" }),
				mock.ws,
			);

			await vi.advanceTimersByTimeAsync(59_000);
			handler.onMessage(
				makeMessageEvent({ type: "ping", id: "keepalive-3" }),
				mock.ws,
			);

			// After 177s total but never silent for >90s
			expect(mock.closed).toBeNull();

			handler.onClose(new CloseEvent("close", { code: 1000 }), mock.ws);
		});

		it("emits ws.disconnect event on ping timeout", async () => {
			const handler = createWsHandler(readAgent, baseDeps);
			const mock = createMockWs();

			handler.onMessage(
				makeMessageEvent({
					type: "capability.request",
					capabilities: ["query_events"],
				}),
				mock.ws,
			);
			mockProcessEvent.mockClear();

			await vi.advanceTimersByTimeAsync(101_000);

			handler.onClose(
				new CloseEvent("close", {
					code: 4011,
					reason: "Ping timeout",
				}),
				mock.ws,
			);

			const disconnectCalls = mockProcessEvent.mock.calls.filter(
				(c) => (c[0] as { type: string }).type === "ws.disconnect",
			);
			expect(disconnectCalls).toHaveLength(1);
			expect(
				(disconnectCalls[0][0] as { detail: { code: number } }).detail.code,
			).toBe(4011);
		});
	});

	describe("revoke handler event emission", () => {
		it("emits session.ops_revoke after revoke_session", async () => {
			mockExecute.mockResolvedValueOnce({
				rows: [],
				rowsAffected: 2,
			});

			const { handler, ws } = negotiatedHandler(writeAgent, [
				"query_events",
				"revoke_session",
			]);
			mockProcessEvent.mockClear();

			handler.onMessage(
				makeMessageEvent({
					type: "revoke_session",
					id: "rs-emit",
					payload: { scope: "user", target_id: 42 },
				}),
				ws,
			);

			await vi.advanceTimersByTimeAsync(0);

			const revokeCalls = mockProcessEvent.mock.calls.filter(
				(c) => (c[0] as { type: string }).type === "session.ops_revoke",
			);
			expect(revokeCalls).toHaveLength(1);
			const detail = (
				revokeCalls[0][0] as {
					detail: {
						scope: string;
						id: number;
						revoked: number;
					};
				}
			).detail;
			expect(detail.scope).toBe("user");
			expect(detail.id).toBe(42);
			expect(detail.revoked).toBe(2);

			handler.onClose(new CloseEvent("close", { code: 1000 }), ws);
		});

		it("emits session.ops_revoke with scope all after revoke_session scope:all", async () => {
			mockExecute.mockResolvedValueOnce({
				rows: [],
				rowsAffected: 10,
			});

			const { handler, ws } = negotiatedHandler(writeAgent, [
				"query_events",
				"revoke_session",
			]);
			mockProcessEvent.mockClear();

			handler.onMessage(
				makeMessageEvent({
					type: "revoke_session",
					id: "rs-all-emit",
					payload: { scope: "all" },
				}),
				ws,
			);

			await vi.advanceTimersByTimeAsync(0);

			const revokeCalls = mockProcessEvent.mock.calls.filter(
				(c) => (c[0] as { type: string }).type === "session.ops_revoke",
			);
			expect(revokeCalls).toHaveLength(1);
			const detail = (
				revokeCalls[0][0] as {
					detail: { scope: string; revoked: number };
				}
			).detail;
			expect(detail.scope).toBe("all");
			expect(detail.revoked).toBe(10);

			handler.onClose(new CloseEvent("close", { code: 1000 }), ws);
		});
	});

	describe("global subscription cap", () => {
		beforeEach(() => {
			_resetSubscriptionCount();
			mockExecute.mockReset();
		});

		it("returns SUBSCRIPTION_LIMIT when global cap is reached", () => {
			// Fill up 50 subscriptions
			const handlers: ReturnType<typeof negotiatedHandler>[] = [];
			for (let i = 0; i < 50; i++) {
				const h = negotiatedHandler();
				mockExecute.mockResolvedValue({ rows: [], rowsAffected: 0 });
				h.handler.onMessage(
					makeMessageEvent({
						type: "subscribe_events",
						id: `sub-${i}`,
						payload: {},
					}),
					h.ws,
				);
				handlers.push(h);
			}

			// 51st should be rejected
			const extra = negotiatedHandler();
			extra.handler.onMessage(
				makeMessageEvent({
					type: "subscribe_events",
					id: "sub-overflow",
					payload: {},
				}),
				extra.ws,
			);

			const responses = extra.parsed();
			const lastResp = responses[responses.length - 1];
			expect(lastResp.ok).toBe(false);
			expect(lastResp.error?.code).toBe("SUBSCRIPTION_LIMIT");

			// Cleanup intervals
			for (const h of handlers) {
				h.handler.onMessage(
					makeMessageEvent({ type: "unsubscribe_events", id: "unsub" }),
					h.ws,
				);
			}
		});
	});
});
