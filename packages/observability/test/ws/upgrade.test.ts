import "./polyfills";
import { beforeEach, describe, expect, it, vi } from "vitest";

type EventCallback = (...args: unknown[]) => void;

// Minimal WebSocket stub that records addEventListener/accept/close calls.
function createMockServerSocket() {
	const listeners: Record<string, EventCallback[]> = {};
	return {
		protocol: "",
		readyState: 1,
		url: null as string | null,
		accepted: false,
		closed: null as { code?: number; reason?: string } | null,
		addEventListener(type: string, fn: EventCallback) {
			if (!listeners[type]) listeners[type] = [];
			listeners[type].push(fn);
		},
		accept() {
			this.accepted = true;
		},
		send: vi.fn(),
		close(code?: number, reason?: string) {
			this.closed = { code, reason };
		},
		/** Fire a stored listener for testing. */
		_emit(type: string, evt: unknown) {
			for (const fn of listeners[type] ?? []) fn(evt);
		},
		_listenerCount(type: string) {
			return (listeners[type] ?? []).length;
		},
	};
}

// Stub WebSocketPair globally so the utility can construct one.
let mockClient: unknown;
let mockServer: ReturnType<typeof createMockServerSocket>;

// Cloudflare Workers allows status 101 in Response; stub it for Node/Bun.
const OriginalResponse = globalThis.Response;
class CFResponse extends OriginalResponse {
	constructor(
		body: BodyInit | null,
		init?: ResponseInit & { webSocket?: unknown },
	) {
		const status = (init?.status ?? 200) === 101 ? 200 : init?.status;
		super(body, { ...init, status });
		Object.defineProperty(this, "status", { value: init?.status ?? 200 });
	}
}

beforeEach(() => {
	mockServer = createMockServerSocket();
	mockClient = { stub: "client" };
	(globalThis as Record<string, unknown>).WebSocketPair = class {
		0 = mockClient;
		1 = mockServer;
	};
	globalThis.Response = CFResponse as typeof Response;
});

// Import after WebSocketPair is stubbed.
const { upgradeWebSocket } = await import("../../src/ws/upgrade");

/** Call the middleware with a mock context. */
async function callMiddleware(
	middleware: ReturnType<typeof upgradeWebSocket>,
	ctx: ReturnType<typeof createMockContext>,
) {
	return (middleware as (...args: unknown[]) => Promise<unknown>)(ctx, vi.fn());
}

/** Minimal Hono Context mock. */
function createMockContext(upgradeHeader = "websocket") {
	return {
		req: {
			header(name: string) {
				if (name === "Upgrade") return upgradeHeader;
				return undefined;
			},
		},
		json(body: unknown, status: number) {
			return { body, status, _type: "json" };
		},
	};
}

describe("upgradeWebSocket", () => {
	it("returns 426 when Upgrade header is missing", async () => {
		const middleware = upgradeWebSocket(() => ({}));
		const ctx = createMockContext("not-websocket");
		const result = await callMiddleware(middleware, ctx);

		expect(result).toMatchObject({ status: 426 });
	});

	it("calls server.accept() and returns 101", async () => {
		const middleware = upgradeWebSocket(() => ({}));
		const ctx = createMockContext();
		const response = (await callMiddleware(middleware, ctx)) as Response;

		expect(mockServer.accepted).toBe(true);
		expect(response.status).toBe(101);
	});

	it("calls onOpen with a WSContext after accept", async () => {
		const onOpen = vi.fn();
		const middleware = upgradeWebSocket(() => ({ onOpen }));
		const ctx = createMockContext();

		await callMiddleware(middleware, ctx);

		expect(mockServer.accepted).toBe(true);
		expect(onOpen).toHaveBeenCalledOnce();

		const [evt, wsCtx] = onOpen.mock.calls[0];
		expect(evt).toBeInstanceOf(Event);
		expect(evt.type).toBe("open");
		expect(wsCtx).toBeDefined();
		expect(typeof wsCtx.send).toBe("function");
		expect(typeof wsCtx.close).toBe("function");
	});

	it("wires onMessage listener to server socket", async () => {
		const onMessage = vi.fn();
		const middleware = upgradeWebSocket(() => ({ onMessage }));
		const ctx = createMockContext();

		await callMiddleware(middleware, ctx);

		expect(mockServer._listenerCount("message")).toBe(1);

		const fakeEvt = new MessageEvent("message", { data: "hello" });
		mockServer._emit("message", fakeEvt);

		expect(onMessage).toHaveBeenCalledOnce();
	});

	it("wires onClose listener and fires callback", async () => {
		const onClose = vi.fn();
		const middleware = upgradeWebSocket(() => ({ onClose }));
		const ctx = createMockContext();

		await callMiddleware(middleware, ctx);

		expect(mockServer._listenerCount("close")).toBe(1);

		const fakeEvt = new CloseEvent("close", { code: 1000, reason: "done" });
		mockServer._emit("close", fakeEvt);

		expect(onClose).toHaveBeenCalledOnce();
	});

	it("skips listeners when events are not provided", async () => {
		const middleware = upgradeWebSocket(() => ({}));
		const ctx = createMockContext();

		await callMiddleware(middleware, ctx);

		expect(mockServer._listenerCount("message")).toBe(0);
		expect(mockServer._listenerCount("close")).toBe(0);
	});

	it("WSContext.send delegates to server.send", async () => {
		const onOpen = vi.fn();
		const middleware = upgradeWebSocket(() => ({ onOpen }));
		const ctx = createMockContext();

		await callMiddleware(middleware, ctx);

		const wsCtx = onOpen.mock.calls[0][1];
		wsCtx.send("test-data");

		expect(mockServer.send).toHaveBeenCalledWith("test-data");
	});

	it("WSContext.close delegates to server.close", async () => {
		const onOpen = vi.fn();
		const middleware = upgradeWebSocket(() => ({ onOpen }));
		const ctx = createMockContext();

		await callMiddleware(middleware, ctx);

		const wsCtx = onOpen.mock.calls[0][1];
		wsCtx.close(4001, "timeout");

		expect(mockServer.closed).toEqual({ code: 4001, reason: "timeout" });
	});

	it("WSContext.readyState reflects server readyState", async () => {
		const onOpen = vi.fn();
		const middleware = upgradeWebSocket(() => ({ onOpen }));
		const ctx = createMockContext();

		await callMiddleware(middleware, ctx);

		const wsCtx = onOpen.mock.calls[0][1];
		expect(wsCtx.readyState).toBe(mockServer.readyState);
	});
});
