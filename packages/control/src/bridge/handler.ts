/**
 * @file handler.ts
 * WebSocket bridge handler for the control plugin (ADR-010).
 * Orchestrates connection lifecycle: PoW negotiation, gateway handshake,
 * capability-filtered relay, session-bound heartbeat, concurrent limiting.
 * Plugin-only – removable with packages/control.
 *
 * @license Apache-2.0
 */

import { createDbClient } from "@private-landing/infrastructure";
import type { WSEvents } from "@private-landing/observability";
import type { WSContext } from "hono/ws";
import { nanoid } from "nanoid";
import type { ControlBindings } from "../types";
import { consumeNonce, generateNonce, verifyPoW } from "./pow";
import { type InboundMessage, inboundMessageSchema } from "./schemas";
import {
	type BridgeConnection,
	type BridgePrincipal,
	CloseCodes,
	type ErrorMessage,
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_TIMEOUT_MS,
	IDLE_TIMEOUT_MS,
	MAX_MESSAGE_BYTES,
	NEGOTIATION_TIMEOUT_MS,
	type NegotiatedMessage,
	type NegotiateResponse,
	POW_DIFFICULTY,
	RATE_LIMIT_MAX,
	RATE_LIMIT_WINDOW_MS,
	type RelayMessage,
	TRUST_CAPABILITIES,
} from "./types";

/** Active connections per user ID — enforces concurrent connection limit. */
const activeConnections = new Map<
	number,
	{ ws: WSContext<WebSocket>; connId: string }
>();

/**
 * Dependencies injected into the bridge handler.
 * @property env - Worker environment bindings
 * @property ipAddress - Client IP for audit trail
 * @property ua - User-Agent string for audit trail
 * @property obsEmitEvent - Observability event emitter (no-op when observability is disabled)
 */
export interface BridgeHandlerDeps {
	env: ControlBindings;
	ipAddress: string;
	ua: string;
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
 * Create a WebSocket event handler for a control bridge connection.
 * Returns WSEvents for use with upgradeWebSocket.
 *
 * Lifecycle: PoW challenge → capability negotiation → gateway handshake → relay.
 * Heartbeat re-validates the Private Landing session (not agent credentials).
 */
export function createBridgeHandler(
	principal: BridgePrincipal,
	deps: BridgeHandlerDeps,
): WSEvents {
	const connId = nanoid();
	const nonce = generateNonce();
	const difficulty = POW_DIFFICULTY;

	const conn: BridgeConnection = {
		id: connId,
		principal,
		state: "awaiting_negotiation",
		granted: [],
		sessionKey: "",
		nonce,
		difficulty,
		backendWs: null,
		lastActivity: Date.now(),
		messageCount: 0,
		messageWindowStart: Date.now(),
		negotiationTimer: null,
		idleTimer: null,
		heartbeatTimer: null,
	};

	let closing = false;

	function send(ws: WSContext<WebSocket>, payload: unknown): void {
		if (closing) return;
		ws.send(JSON.stringify(payload));
	}

	function sendError(
		ws: WSContext<WebSocket>,
		type: string,
		message: string,
	): void {
		try {
			const err: ErrorMessage = { error: { type, message } };
			send(ws, err);
		} catch {
			/* connection may be closed */
		}
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
		if (conn.negotiationTimer) clearTimeout(conn.negotiationTimer);
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
			sendError(ws, "idle_timeout", "Connection idle timeout");
			closeWith(ws, CloseCodes.IDLE_TIMEOUT, "Idle timeout");
			cleanup();
		}, IDLE_TIMEOUT_MS);
	}

	/** Re-validate Private Landing session via database (ADR-010 §Session-Bound Bridge). */
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
				send(ws, {
					type: "session.revoked",
					reason: "session_expired_or_revoked",
					guidance: "Re-authenticate via /auth/login",
				});
				closeWith(ws, CloseCodes.SESSION_REVOKED, "Session revoked");
				cleanup();
				return false;
			}
			return true;
		} catch (err) {
			// Fail-closed — if we can't verify the session, drop the connection
			console.error("[ctl] session check failed:", err);
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
			const valid = await checkSessionValidity(ws);
			if (!valid) return;
			send(ws, {
				type: "heartbeat",
				ts: Date.now(),
				next_check_ms: HEARTBEAT_INTERVAL_MS,
				capabilities: conn.granted,
			});
		}, HEARTBEAT_INTERVAL_MS);
	}

	// --- Gateway backend ---

	/**
	 * Connect to the gateway backend and complete the handshake:
	 * 1. Wait for connect.challenge event
	 * 2. Send connect req with role, scopes, auth (token injected server-side)
	 * 3. Wait for hello-ok response
	 * Then relay res/event frames to the client.
	 */
	function connectBackend(ws: WSContext<WebSocket>): Promise<void> {
		const gatewayUrl = deps.env.GATEWAY_URL;
		const gatewayToken = deps.env.GATEWAY_TOKEN;
		if (!gatewayUrl) return Promise.reject(new Error("No GATEWAY_URL"));

		return new Promise((resolve, reject) => {
			// Standard WebSocket constructor — no custom headers (Workers-compatible)
			const backend = new WebSocket(gatewayUrl);

			const timeout = setTimeout(() => {
				backend.close();
				reject(new Error("Backend connection timeout"));
			}, 5000);

			let handshakePhase: "awaiting_challenge" | "awaiting_hello" | "ready" =
				"awaiting_challenge";

			backend.addEventListener("open", () => {
				conn.backendWs = backend;
			});

			backend.addEventListener("error", () => {
				clearTimeout(timeout);
				reject(new Error("Backend connection error"));
			});

			backend.addEventListener("message", (ev) => {
				try {
					const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;

					// Phase 1: gateway sends connect.challenge
					if (
						handshakePhase === "awaiting_challenge" &&
						frame.type === "event" &&
						frame.event === "connect.challenge"
					) {
						handshakePhase = "awaiting_hello";
						backend.send(
							JSON.stringify({
								type: "req",
								method: "connect",
								id: "_connect",
								params: {
									role: "operator",
									client: {
										id: "gateway-client",
										version: "2.0.0",
										platform: "bridge",
										mode: "backend",
									},
									minProtocol: 3,
									maxProtocol: 3,
									scopes: ["operator.read", "operator.write"],
									auth: { token: gatewayToken ?? "" },
								},
							}),
						);
						return;
					}

					// Phase 2: gateway responds with hello-ok
					if (handshakePhase === "awaiting_hello" && frame.type === "res") {
						const payload = frame.payload as {
							type?: string;
						} | null;
						if (payload?.type === "hello-ok") {
							clearTimeout(timeout);
							handshakePhase = "ready";
							resolve();
						} else {
							clearTimeout(timeout);
							reject(new Error("Backend handshake rejected"));
						}
						return;
					}

					if (handshakePhase !== "ready") return;

					// Post-handshake: relay frames to client
					if (frame.type === "event") {
						const eventName = frame.event as string | undefined;
						const ns = eventName?.split(".")[0];
						if (ns && !conn.granted.includes(ns)) return;
						const relay: RelayMessage = {
							type: "relay",
							event: eventName,
							params: frame.params as Record<string, unknown> | undefined,
						};
						send(ws, relay);
					} else if (frame.type === "res") {
						if (frame.error) {
							send(ws, {
								type: "relay",
								id: frame.id,
								error: frame.error,
							});
						} else {
							const relay: RelayMessage = {
								type: "relay",
								result: frame.payload,
								id: frame.id as string | undefined,
							};
							send(ws, relay);
						}
					}
				} catch (err) {
					console.error("[ctl] unparseable backend frame:", err);
				}
			});

			backend.addEventListener("close", () => {
				if (conn.state === "active") {
					sendError(ws, "backend_closed", "Backend disconnected");
					closeWith(
						ws,
						CloseCodes.BACKEND_DISCONNECTED,
						"Backend disconnected",
					);
					cleanup();
				}
			});
		});
	}

	// --- Relay ---

	function handleRelayToBackend(
		ws: WSContext<WebSocket>,
		msg: RelayMessage,
	): void {
		resetIdleTimer(ws);

		const namespace = msg.method?.split(".")[0] ?? msg.event?.split(".")[0];
		if (namespace && !conn.granted.includes(namespace)) {
			const err: ErrorMessage = {
				error: {
					type: "capability_denied",
					message: `Not authorized for namespace: ${namespace}`,
				},
			};
			if (msg.id !== undefined) {
				send(ws, { ...err, id: msg.id });
			} else {
				send(ws, err);
			}
			return;
		}

		if (!conn.backendWs || conn.backendWs.readyState !== WebSocket.OPEN) {
			sendError(ws, "backend_error", "Backend connection not available");
			return;
		}

		const frame = {
			type: "req",
			method: msg.method,
			params: { ...msg.params, sessionKey: conn.sessionKey },
			id: msg.id,
		};
		conn.backendWs.send(JSON.stringify(frame));
	}

	// --- Negotiation ---

	async function handleNegotiateResponse(
		ws: WSContext<WebSocket>,
		msg: NegotiateResponse,
	): Promise<void> {
		if (conn.negotiationTimer) {
			clearTimeout(conn.negotiationTimer);
			conn.negotiationTimer = null;
		}

		if (!consumeNonce(conn.nonce)) {
			emit("control.pow_rejected", { reason: "nonce_replay" });
			sendError(ws, "negotiation_failed", "Nonce already consumed");
			closeWith(ws, CloseCodes.NONCE_REPLAY, "Nonce replay");
			cleanup();
			return;
		}

		const valid = await verifyPoW(conn.nonce, msg.solution, conn.difficulty);
		if (!valid) {
			emit("control.pow_rejected", { reason: "invalid_solution" });
			sendError(ws, "negotiation_failed", "Invalid proof of work");
			closeWith(ws, CloseCodes.INVALID_POW, "Invalid PoW");
			cleanup();
			return;
		}

		const allowed = TRUST_CAPABILITIES[conn.principal.trustLevel] ?? [];
		const granted = msg.capabilities.filter((c) => allowed.includes(c));
		if (granted.length === 0) {
			sendError(
				ws,
				"negotiation_failed",
				"No capabilities granted for your trust level",
			);
			closeWith(ws, CloseCodes.NO_CAPABILITIES, "No capabilities granted");
			cleanup();
			return;
		}

		const sessionKey = `agent:${conn.principal.name}:main`;
		conn.granted = granted;
		conn.sessionKey = sessionKey;
		conn.state = "active";

		resetIdleTimer(ws);
		startHeartbeat(ws);

		try {
			await connectBackend(ws);
		} catch (err) {
			console.error("[ctl] backend connect failed:", err);
			sendError(ws, "backend_error", "Failed to connect to backend");
			closeWith(ws, CloseCodes.BACKEND_UNAVAILABLE, "Backend unavailable");
			cleanup();
			return;
		}

		const response: NegotiatedMessage = {
			type: "negotiated",
			granted,
			sessionKey,
		};
		send(ws, response);

		emit("control.ws_connect", {
			sessionId: principal.sid,
			granted,
			sessionKey,
		});
	}

	// --- WSEvents ---

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

			// Start negotiation timeout
			conn.negotiationTimer = setTimeout(() => {
				if (conn.state === "awaiting_negotiation") {
					sendError(ws, "negotiation_timeout", "Negotiation timed out");
					closeWith(ws, CloseCodes.NEGOTIATION_TIMEOUT, "Negotiation timeout");
					cleanup();
				}
			}, NEGOTIATION_TIMEOUT_MS);

			// Send PoW challenge
			send(ws, {
				type: "negotiate",
				nonce,
				challenge: `PoW difficulty ${difficulty}`,
			});
		},

		onMessage(evt, ws) {
			conn.lastActivity = Date.now();

			const raw = typeof evt.data === "string" ? evt.data : String(evt.data);

			if (raw.length > MAX_MESSAGE_BYTES) {
				sendError(
					ws,
					"message_too_large",
					`Max message size is ${MAX_MESSAGE_BYTES} bytes`,
				);
				return;
			}

			if (!checkRateLimit()) {
				sendError(ws, "rate_limited", "Too many messages");
				closeWith(ws, CloseCodes.RATE_LIMITED, "Rate limited");
				cleanup();
				return;
			}

			let parsed: InboundMessage;
			try {
				const json = JSON.parse(raw) as unknown;
				const result = inboundMessageSchema.safeParse(json);
				if (!result.success) {
					sendError(ws, "protocol_error", "Invalid message");
					return;
				}
				parsed = result.data;
			} catch {
				sendError(ws, "parse_error", "Invalid JSON");
				return;
			}

			if (conn.state === "awaiting_negotiation") {
				if (parsed.type === "negotiate") {
					handleNegotiateResponse(ws, parsed as NegotiateResponse);
				} else {
					sendError(ws, "protocol_error", "Expected negotiation response");
				}
				return;
			}

			if (conn.state === "active") {
				if (parsed.type === "relay") {
					handleRelayToBackend(ws, parsed as RelayMessage);
				} else if (parsed.type === "ping") {
					send(ws, {
						type: "pong",
						id: parsed.id,
						ok: true,
					});
				} else {
					sendError(ws, "protocol_error", "Unexpected message type");
				}
				return;
			}

			sendError(ws, "protocol_error", "Unexpected message");
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
