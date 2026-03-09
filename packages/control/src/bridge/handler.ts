/**
 * @file handler.ts
 * Transparent WebSocket proxy for the control plugin (ADR-010).
 * Relays frames between the browser and gateway, injecting GATEWAY_TOKEN
 * into the connect handshake server-side. No PoW, no capability filtering —
 * the control UI speaks the gateway's native protocol directly.
 * Plugin-only – removable with packages/control.
 *
 * @license Apache-2.0
 */

import { createDbClient } from "@private-landing/infrastructure";
import type { WSEvents } from "@private-landing/observability";
import type { WSContext } from "hono/ws";
import { nanoid } from "nanoid";
import { type ControlBindings, isSafeGatewayUrl } from "../types";
import {
	type BridgePrincipal,
	CloseCodes,
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_TIMEOUT_MS,
	IDLE_TIMEOUT_MS,
	MAX_MESSAGE_BYTES,
	MAX_PENDING_MESSAGES,
	type ProxyConnection,
	RATE_LIMIT_MAX,
	RATE_LIMIT_WINDOW_MS,
} from "./types";

/** Active connections per user ID — enforces concurrent connection limit. */
const activeConnections = new Map<
	number,
	{ ws: WSContext<WebSocket>; connId: string }
>();

/**
 * Dependencies injected into the proxy handler.
 * @property env - Worker environment bindings
 * @property ipAddress - Client IP for audit trail
 * @property ua - User-Agent string for audit trail
 * @property obsEmitEvent - Observability event emitter (no-op when observability is disabled)
 */
export interface ProxyHandlerDeps {
	env: ControlBindings;
	ipAddress: string;
	ua: string;
	origin?: string;
	obsEmitEvent?: (
		ctx: {
			req: {
				url: string;
				header: (name: string) => string | undefined;
			};
			env: ControlBindings;
			executionCtx?: { waitUntil(promise: Promise<unknown>): void };
		},
		event: {
			type: string;
			userId?: number;
			detail?: Record<string, unknown>;
		},
	) => void;
}

/**
 * Create a WebSocket event handler for a transparent gateway proxy.
 * Returns WSEvents for use with upgradeWebSocket.
 *
 * Lifecycle: connect backend → relay frames (injecting token on connect) → heartbeat.
 * The browser speaks the gateway's native protocol; PL injects GATEWAY_TOKEN
 * into the connect request so the browser never sees the token.
 */
export function createProxyHandler(
	principal: BridgePrincipal,
	deps: ProxyHandlerDeps,
): WSEvents {
	const connId = nanoid();

	const conn: ProxyConnection = {
		id: connId,
		principal,
		state: "connecting",
		backendWs: null,
		lastActivity: Date.now(),
		messageCount: 0,
		messageWindowStart: Date.now(),
		pendingMessages: [],
		idleTimer: null,
		heartbeatTimer: null,
	};

	let closing = false;

	function sendToClient(ws: WSContext<WebSocket>, data: string): void {
		if (closing) return;
		ws.send(data);
	}

	function closeWith(
		ws: WSContext<WebSocket>,
		code: number,
		reason: string,
	): void {
		closing = true;
		ws.close(code, reason);
	}

	function emit(type: string, detail?: Record<string, unknown>): void {
		deps.obsEmitEvent?.(
			{
				req: {
					url: "",
					header: (name: string) =>
						name === "user-agent" ? deps.ua : undefined,
				},
				env: deps.env,
			},
			{
				type,
				userId: principal.uid,
				detail: { connectionId: connId, ...detail },
			},
		);
	}

	function cleanup(): void {
		if (conn.state === "closed") return;
		conn.state = "closed";
		if (conn.idleTimer) clearTimeout(conn.idleTimer);
		if (conn.heartbeatTimer) clearInterval(conn.heartbeatTimer);
		if (conn.backendWs) {
			try {
				conn.backendWs.close();
			} catch {
				/* ignore */
			}
		}
		const active = activeConnections.get(principal.uid);
		if (active?.connId === connId) {
			activeConnections.delete(principal.uid);
		}
	}

	function checkRateLimit(): boolean {
		const now = Date.now();
		if (now - conn.messageWindowStart > RATE_LIMIT_WINDOW_MS) {
			conn.messageWindowStart = now;
			conn.messageCount = 1;
			return true;
		}
		conn.messageCount++;
		return conn.messageCount <= RATE_LIMIT_MAX;
	}

	function resetIdleTimer(ws: WSContext<WebSocket>): void {
		if (conn.idleTimer) clearTimeout(conn.idleTimer);
		conn.idleTimer = setTimeout(() => {
			emit("control.ws_disconnect", { reason: "idle_timeout" });
			closeWith(ws, CloseCodes.IDLE_TIMEOUT, "Idle timeout");
			cleanup();
		}, IDLE_TIMEOUT_MS);
	}

	/** Re-validate Private Landing session via database (ADR-010 §Session-Bound Proxy). */
	async function checkSessionValidity(
		ws: WSContext<WebSocket>,
	): Promise<boolean> {
		try {
			const db = createDbClient(deps.env);
			const result = await db.execute({
				sql: "SELECT expires_at FROM session WHERE id = ? AND expires_at > datetime('now')",
				args: [principal.sid],
			});
			if (result.rows.length === 0) {
				emit("control.ws_disconnect", { reason: "session_revoked" });
				closeWith(ws, CloseCodes.SESSION_REVOKED, "Session revoked");
				cleanup();
				return false;
			}
			return true;
		} catch (err) {
			console.error(
				"[ctl] session check failed:",
				err instanceof Error ? err.message : "unknown",
			);
			emit("control.ws_disconnect", { reason: "session_check_error" });
			closeWith(ws, CloseCodes.SESSION_REVOKED, "Session check unavailable");
			cleanup();
			return false;
		}
	}

	function startHeartbeat(ws: WSContext<WebSocket>): void {
		conn.heartbeatTimer = setInterval(async () => {
			if (Date.now() - conn.lastActivity > HEARTBEAT_TIMEOUT_MS) {
				emit("control.ws_disconnect", { reason: "ping_timeout" });
				closeWith(ws, CloseCodes.PING_TIMEOUT, "Ping timeout");
				cleanup();
				return;
			}
			await checkSessionValidity(ws);
		}, HEARTBEAT_INTERVAL_MS);
	}

	/**
	 * Inject GATEWAY_TOKEN into a connect request frame.
	 * If the frame is a `{ type: "req", method: "connect", params: { auth: ... } }`
	 * message, replaces `params.auth.token` with the server-side token.
	 * All other frames pass through unchanged.
	 */
	function injectToken(raw: string): string {
		const token = deps.env.GATEWAY_TOKEN;
		if (!token) return raw;

		try {
			const frame = JSON.parse(raw) as Record<string, unknown>;
			if (frame.type !== "req" || frame.method !== "connect") return raw;

			const params = frame.params as Record<string, unknown> | undefined;
			if (!params) return raw;

			params.auth = { token };
			return JSON.stringify(frame);
		} catch {
			return raw;
		}
	}

	/**
	 * Open outbound WebSocket to the gateway.
	 * Uses fetch-based upgrade (Workers) to forward the browser's Origin header,
	 * falling back to new WebSocket() (Bun local dev) when fetch upgrade is
	 * unavailable. The Origin is needed because the gateway validates it on the
	 * transport-level WebSocket handshake.
	 */
	async function openBackendSocket(wsUrl: string): Promise<WebSocket> {
		// Fetch-based upgrade allows setting Origin (Cloudflare Workers).
		// The response carries a .webSocket property when the upgrade succeeds.
		if (deps.origin) {
			try {
				const fetchUrl = wsUrl
					.replace(/^wss:\/\//, "https://")
					.replace(/^ws:\/\//, "http://");
				const resp = await fetch(fetchUrl, {
					headers: {
						Upgrade: "websocket",
						Origin: deps.origin,
					},
				});
				const ws = (resp as unknown as { webSocket?: WebSocket }).webSocket;
				if (ws) {
					(ws as { accept?: () => void }).accept?.();
					return ws;
				}
			} catch {
				/* fall through to standard constructor */
			}
		}
		return new WebSocket(wsUrl);
	}

	/** Connect to the gateway backend WebSocket. */
	function connectBackend(ws: WSContext<WebSocket>): void {
		const gatewayUrl = deps.env.GATEWAY_URL;
		if (!gatewayUrl || !isSafeGatewayUrl(gatewayUrl, deps.env.ENVIRONMENT)) {
			closeWith(ws, CloseCodes.BACKEND_UNAVAILABLE, "No GATEWAY_URL");
			cleanup();
			return;
		}

		// Auto-convert http(s) to ws(s) so a single GATEWAY_URL works for
		// both the proxy (fetch) and the WebSocket proxy.
		const wsUrl = gatewayUrl
			.replace(/^https:\/\//, "wss://")
			.replace(/^http:\/\//, "ws://");

		const timeout = setTimeout(() => {
			closeWith(ws, CloseCodes.BACKEND_UNAVAILABLE, "Backend timeout");
			cleanup();
		}, 5000);

		openBackendSocket(wsUrl)
			.then((backend) => {
				if (conn.state === "closed") {
					backend.close();
					return;
				}

				function activate(): void {
					clearTimeout(timeout);
					conn.backendWs = backend;
					conn.state = "active";

					for (const msg of conn.pendingMessages) {
						backend.send(injectToken(msg));
					}
					conn.pendingMessages = [];

					resetIdleTimer(ws);
					startHeartbeat(ws);

					emit("control.ws_connect", { sessionId: principal.sid });
				}

				// Fetch-based sockets are already open; standard sockets need the open event
				if (backend.readyState === WebSocket.OPEN) {
					activate();
				} else {
					backend.addEventListener("open", activate);
				}

				backend.addEventListener("error", () => {
					clearTimeout(timeout);
					if (conn.state !== "closed") {
						closeWith(ws, CloseCodes.BACKEND_UNAVAILABLE, "Backend error");
						cleanup();
					}
				});

				backend.addEventListener("message", (ev) => {
					sendToClient(ws, String(ev.data));
				});

				backend.addEventListener("close", () => {
					if (conn.state === "active") {
						closeWith(
							ws,
							CloseCodes.BACKEND_DISCONNECTED,
							"Backend disconnected",
						);
						cleanup();
					}
				});
			})
			.catch(() => {
				clearTimeout(timeout);
				if (conn.state !== "closed") {
					closeWith(ws, CloseCodes.BACKEND_UNAVAILABLE, "Backend unavailable");
					cleanup();
				}
			});
	}

	return {
		onOpen(_evt, ws) {
			// Enforce concurrent connection limit (ADR-010 §Concurrent Connection Limit)
			const existing = activeConnections.get(principal.uid);
			if (existing) {
				try {
					existing.ws.close(
						CloseCodes.SUPERSEDED,
						"Superseded by new connection",
					);
				} catch {
					/* ignore */
				}
				emit("control.ws_disconnect", {
					reason: "superseded",
					oldConnId: existing.connId,
				});
			}
			activeConnections.set(principal.uid, { ws, connId });

			connectBackend(ws);
		},

		onMessage(evt, ws) {
			conn.lastActivity = Date.now();

			if (typeof evt.data !== "string") {
				closeWith(ws, 1003, "Binary frames not supported");
				cleanup();
				return;
			}
			const raw = evt.data;

			if (raw.length > MAX_MESSAGE_BYTES) {
				closeWith(ws, 1009, "Message too large");
				cleanup();
				return;
			}

			if (!checkRateLimit()) {
				closeWith(ws, CloseCodes.RATE_LIMITED, "Rate limited");
				cleanup();
				return;
			}

			if (conn.state === "connecting") {
				if (conn.pendingMessages.length >= MAX_PENDING_MESSAGES) {
					closeWith(ws, CloseCodes.RATE_LIMITED, "Too many pending messages");
					cleanup();
					return;
				}
				conn.pendingMessages.push(raw);
				return;
			}

			if (
				conn.state === "active" &&
				conn.backendWs?.readyState === WebSocket.OPEN
			) {
				conn.backendWs.send(injectToken(raw));
				resetIdleTimer(ws);
			}
		},

		onClose(evt) {
			const { code, reason } = evt as CloseEvent;
			emit("control.ws_disconnect", { code, reason });
			cleanup();
		},
	};
}

/** Reset active connections. Exported for testing only. @internal */
export function _resetActiveConnections(): void {
	activeConnections.clear();
}
