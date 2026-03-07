/**
 * @file relay.ts
 * WebSocket bridge relay implementing adaptive PoW negotiation, capability-filtered
 * message forwarding, heartbeat credential re-validation, and nonce replay prevention.
 * Experiment-only – isolated in experiments/ws-bridge.
 *
 * @license Apache-2.0
 */

import type { ServerWebSocket } from "bun";
import { nanoid } from "nanoid";
import { checkCredentialValid } from "../middleware/auth";
import {
	type AdaptivePoWConfig,
	type AgentPrincipal,
	type BridgeConnection,
	type ErrorMessage,
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_TIMEOUT_MS,
	IDLE_TIMEOUT_MS,
	MAX_CREDENTIAL_CHECK_FAILURES,
	MAX_MESSAGE_BYTES,
	NEGOTIATION_TIMEOUT_MS,
	type NegotiatedMessage,
	type NegotiateResponse,
	NONCE_TTL_MS,
	POW_DEFAULTS,
	RATE_LIMIT_MAX,
	RATE_LIMIT_WINDOW_MS,
	type RelayMessage,
	TRUST_CAPABILITIES,
	type WsData,
} from "../types";

/**
 * Manages WebSocket connections through the full lifecycle: PoW challenge,
 * capability negotiation, namespace-filtered relay, and heartbeat monitoring.
 */
export class BridgeRelay {
	private connections = new Map<string, BridgeConnection>();
	private backendUrl: string;
	private gatewayToken: string | undefined;
	private powConfig: AdaptivePoWConfig;

	/** Per-IP connection count within the adaptive window */
	private connectionPressure = new Map<
		string,
		{ count: number; windowStart: number }
	>();

	/** Seen nonces with expiry timestamps for replay prevention */
	private seenNonces = new Map<string, number>();
	private nonceCleanupTimer: ReturnType<typeof setInterval>;

	constructor(
		backendUrl: string,
		gatewayToken?: string,
		powConfig?: Partial<AdaptivePoWConfig>,
	) {
		this.backendUrl = backendUrl;
		this.gatewayToken = gatewayToken;
		this.powConfig = { ...POW_DEFAULTS, ...powConfig };

		// Periodic cleanup of expired nonces
		this.nonceCleanupTimer = setInterval(
			() => this.pruneExpiredNonces(),
			NONCE_TTL_MS,
		);
	}

	/** Initializes connection state, computes adaptive difficulty, and sends PoW challenge. */
	handleOpen(
		ws: ServerWebSocket<WsData>,
		agent: AgentPrincipal,
		clientIp?: string,
	): void {
		const connId = nanoid();
		const nonce = this.generateNonce();
		const difficulty = this.computeDifficulty(clientIp);

		const conn: BridgeConnection = {
			id: connId,
			agent,
			state: "awaiting_negotiation",
			granted: [],
			session: "",
			nonce,
			difficulty,
			backendWs: null,
			lastActivity: Date.now(),
			messageCount: 0,
			messageWindowStart: Date.now(),
			negotiationTimer: null,
			idleTimer: null,
			heartbeatTimer: null,
			credentialCheckFailures: 0,
		};

		ws.data.connId = connId;
		this.connections.set(connId, conn);

		// Track connection pressure per IP
		if (clientIp) {
			this.recordConnectionPressure(clientIp);
		}

		this.log("connection.open", {
			connId,
			agent: agent.name,
			trustLevel: agent.trustLevel,
			difficulty,
		});

		// Start negotiation timeout
		conn.negotiationTimer = setTimeout(() => {
			if (conn.state === "awaiting_negotiation") {
				this.log("negotiation.timeout", { connId });
				this.sendError(ws, "negotiation_timeout", "Negotiation timed out");
				ws.close(4408, "Negotiation timeout");
				this.cleanup(connId);
			}
		}, NEGOTIATION_TIMEOUT_MS);

		// Send challenge with adaptive difficulty
		ws.send(
			JSON.stringify({
				type: "negotiate",
				nonce,
				challenge: `PoW difficulty ${difficulty}`,
			}),
		);
	}

	/** Routes inbound messages through size/rate checks to negotiation or relay handlers. */
	async handleMessage(ws: ServerWebSocket<WsData>, raw: string): Promise<void> {
		const conn = this.connections.get(ws.data.connId);
		if (!conn) {
			ws.close(4000, "Unknown connection");
			return;
		}

		conn.lastActivity = Date.now();

		if (raw.length > MAX_MESSAGE_BYTES) {
			this.sendError(
				ws,
				"message_too_large",
				`Max message size is ${MAX_MESSAGE_BYTES} bytes`,
			);
			return;
		}

		if (!this.checkRateLimit(conn)) {
			this.sendError(ws, "rate_limited", "Too many messages");
			return;
		}

		let msg: NegotiateResponse | RelayMessage;
		try {
			msg = JSON.parse(raw) as NegotiateResponse | RelayMessage;
		} catch {
			this.sendError(ws, "parse_error", "Invalid JSON");
			return;
		}

		if (conn.state === "awaiting_negotiation") {
			if (msg.type === "negotiate") {
				await this.handleNegotiateResponse(conn, ws, msg as NegotiateResponse);
			} else {
				this.sendError(ws, "protocol_error", "Expected negotiation response");
			}
			return;
		}

		if (conn.state === "active") {
			if (msg.type === "relay") {
				this.handleRelayToBackend(conn, ws, msg as RelayMessage);
			} else if ((msg as Record<string, unknown>).type === "ping") {
				ws.send(
					JSON.stringify({
						type: "pong",
						id: (msg as Record<string, unknown>).id,
						ok: true,
					}),
				);
			} else {
				this.sendError(ws, "protocol_error", "Unexpected message");
			}
			return;
		}

		this.sendError(ws, "protocol_error", "Unexpected message");
	}

	/** Cleans up connection state, timers, and backend WebSocket on close. */
	handleClose(ws: ServerWebSocket<WsData>): void {
		const connId = ws.data?.connId;
		if (connId) {
			this.log("connection.close", { connId });
			this.cleanup(connId);
		}
	}

	/** Stops the nonce cleanup timer. Call on server shutdown. */
	destroy(): void {
		clearInterval(this.nonceCleanupTimer);
	}

	// --- Adaptive PoW ---

	private computeDifficulty(clientIp?: string): number {
		if (!clientIp) return this.powConfig.baseDifficulty;

		const pressure = this.connectionPressure.get(clientIp);
		if (!pressure) return this.powConfig.baseDifficulty;

		const now = Date.now();
		if (now - pressure.windowStart > this.powConfig.windowMs) {
			return this.powConfig.baseDifficulty;
		}

		if (pressure.count >= this.powConfig.highPressureThreshold) {
			return this.powConfig.highDifficulty;
		}
		if (pressure.count >= this.powConfig.pressureThreshold) {
			// Linear interpolation between base and high
			const range =
				this.powConfig.highPressureThreshold - this.powConfig.pressureThreshold;
			const progress =
				(pressure.count - this.powConfig.pressureThreshold) / range;
			return Math.round(
				this.powConfig.baseDifficulty +
					(this.powConfig.highDifficulty - this.powConfig.baseDifficulty) *
						progress,
			);
		}

		return this.powConfig.baseDifficulty;
	}

	private recordConnectionPressure(clientIp: string): void {
		const now = Date.now();
		const existing = this.connectionPressure.get(clientIp);
		if (!existing || now - existing.windowStart > this.powConfig.windowMs) {
			this.connectionPressure.set(clientIp, { count: 1, windowStart: now });
		} else {
			existing.count++;
		}
	}

	// --- Nonce dedup ---

	private consumeNonce(nonce: string): boolean {
		if (this.seenNonces.has(nonce)) {
			return false;
		}
		this.seenNonces.set(nonce, Date.now() + NONCE_TTL_MS);
		return true;
	}

	private pruneExpiredNonces(): void {
		const now = Date.now();
		for (const [nonce, expiry] of this.seenNonces) {
			if (expiry <= now) {
				this.seenNonces.delete(nonce);
			}
		}
	}

	// --- Negotiation ---

	private async handleNegotiateResponse(
		conn: BridgeConnection,
		ws: ServerWebSocket<WsData>,
		msg: NegotiateResponse,
	): Promise<void> {
		if (conn.negotiationTimer) {
			clearTimeout(conn.negotiationTimer);
			conn.negotiationTimer = null;
		}

		// Nonce replay check
		if (!this.consumeNonce(conn.nonce)) {
			this.log("negotiation.failed", {
				connId: conn.id,
				reason: "nonce_replay",
			});
			this.sendError(ws, "negotiation_failed", "Nonce already consumed");
			ws.close(4403, "Nonce replay");
			this.cleanup(conn.id);
			return;
		}

		const valid = await this.verifyPoW(
			conn.nonce,
			msg.solution,
			conn.difficulty,
		);
		if (!valid) {
			this.log("negotiation.failed", {
				connId: conn.id,
				reason: "invalid_pow",
			});
			this.sendError(ws, "negotiation_failed", "Invalid proof of work");
			ws.close(4403, "Invalid PoW");
			this.cleanup(conn.id);
			return;
		}

		const allowed = TRUST_CAPABILITIES[conn.agent.trustLevel] ?? [];
		const granted = msg.capabilities.filter((c) => allowed.includes(c));

		if (granted.length === 0) {
			this.log("negotiation.failed", {
				connId: conn.id,
				reason: "no_capabilities",
			});
			this.sendError(
				ws,
				"negotiation_failed",
				"No requested capabilities are allowed for your trust level",
			);
			ws.close(4403, "No capabilities granted");
			this.cleanup(conn.id);
			return;
		}

		const sessionKey = `agent:${conn.agent.name}:main`;
		conn.granted = granted;
		conn.session = sessionKey;
		conn.state = "active";

		this.resetIdleTimer(conn, ws);
		this.startHeartbeat(conn, ws);

		try {
			await this.connectBackend(conn, ws);
		} catch (err) {
			this.log("backend.connect_failed", {
				connId: conn.id,
				error: String(err),
			});
			this.sendError(ws, "backend_error", "Failed to connect to backend");
			ws.close(4502, "Backend unavailable");
			this.cleanup(conn.id);
			return;
		}

		const response: NegotiatedMessage = {
			type: "negotiated",
			granted,
			sessionKey,
		};
		ws.send(JSON.stringify(response));

		this.log("negotiation.success", {
			connId: conn.id,
			agent: conn.agent.name,
			granted,
			sessionKey,
		});
	}

	// --- Heartbeat (matching core ws/handler.ts pattern) ---

	private startHeartbeat(
		conn: BridgeConnection,
		ws: ServerWebSocket<WsData>,
	): void {
		conn.heartbeatTimer = setInterval(() => {
			// Idle detection
			if (Date.now() - conn.lastActivity > HEARTBEAT_TIMEOUT_MS) {
				this.log("connection.ping_timeout", { connId: conn.id });
				this.sendError(ws, "ping_timeout", "No activity detected");
				ws.close(4408, "Ping timeout");
				this.cleanup(conn.id);
				return;
			}

			// Credential re-validation
			const valid = checkCredentialValid(conn.agent.id);
			if (!valid) {
				conn.credentialCheckFailures++;
				if (conn.credentialCheckFailures >= MAX_CREDENTIAL_CHECK_FAILURES) {
					this.log("credential.revoked", {
						connId: conn.id,
						agent: conn.agent.name,
					});
					try {
						ws.send(
							JSON.stringify({
								type: "credential.revoked",
								reason: "key_revoked_or_expired",
								guidance: "Re-authenticate with a valid agent key",
							}),
						);
					} catch {
						// Connection may be closing
					}
					ws.close(4010, "Credential revoked");
					this.cleanup(conn.id);
					return;
				}
			} else {
				conn.credentialCheckFailures = 0;
			}

			// Send heartbeat
			try {
				ws.send(
					JSON.stringify({
						type: "heartbeat",
						ts: Date.now(),
						next_check_ms: HEARTBEAT_INTERVAL_MS,
						capabilities: conn.granted,
					}),
				);
			} catch {
				// Connection may be closing
			}
		}, HEARTBEAT_INTERVAL_MS);
	}

	// --- Relay ---

	private handleRelayToBackend(
		conn: BridgeConnection,
		ws: ServerWebSocket<WsData>,
		msg: RelayMessage,
	): void {
		this.resetIdleTimer(conn, ws);

		const namespace = msg.method?.split(".")[0] ?? msg.event?.split(".")[0];
		if (namespace && !conn.granted.includes(namespace)) {
			this.log("capability.denied", {
				connId: conn.id,
				namespace,
				method: msg.method,
			});
			const err: ErrorMessage = {
				error: {
					type: "capability_denied",
					message: `Not authorized for capability namespace: ${namespace}`,
				},
			};
			if (msg.id !== undefined) {
				ws.send(JSON.stringify({ ...err, id: msg.id }));
			} else {
				ws.send(JSON.stringify(err));
			}
			return;
		}

		if (!conn.backendWs || conn.backendWs.readyState !== WebSocket.OPEN) {
			this.sendError(ws, "backend_error", "Backend connection not available");
			return;
		}

		// Gateway frame format: {type: "req", id, method, params}
		const frame = {
			type: "req",
			method: msg.method,
			params: { ...msg.params, sessionKey: conn.session },
			id: msg.id,
		};
		conn.backendWs.send(JSON.stringify(frame));
	}

	// --- Backend ---

	/**
	 * Connects to the gateway backend and completes the handshake:
	 * 1. Wait for connect.challenge event
	 * 2. Send connect req with role, scopes, auth
	 * 3. Wait for hello-ok response
	 * Then installs the message handler for relaying res/event frames.
	 */
	private connectBackend(
		conn: BridgeConnection,
		ws: ServerWebSocket<WsData>,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			const backend = this.gatewayToken
				? new WebSocket(this.backendUrl, {
						// @ts-expect-error Bun supports headers on client WebSocket
						headers: { Authorization: `Bearer ${this.gatewayToken}` },
					})
				: new WebSocket(this.backendUrl);

			const timeout = setTimeout(() => {
				backend.close();
				reject(new Error("Backend connection timeout"));
			}, 5000);

			let handshakePhase: "awaiting_challenge" | "awaiting_hello" | "ready" =
				"awaiting_challenge";

			backend.onopen = () => {
				conn.backendWs = backend;
				this.log("backend.connected", { connId: conn.id });
			};

			backend.onerror = () => {
				clearTimeout(timeout);
				reject(new Error("Backend connection error"));
			};

			backend.onmessage = (ev) => {
				try {
					const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;

					// Handshake phase 1: wait for connect.challenge
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
										version: "2.0.0-exp",
										platform: "bridge",
										mode: "backend",
									},
									minProtocol: 3,
									maxProtocol: 3,
									scopes: ["operator.read", "operator.write"],
									auth: { token: this.gatewayToken ?? "" },
								},
							}),
						);
						return;
					}

					// Handshake phase 2: wait for hello-ok
					if (handshakePhase === "awaiting_hello" && frame.type === "res") {
						const payload = frame.payload as
							| { type?: string }
							| null
							| undefined;
						if (payload?.type === "hello-ok") {
							clearTimeout(timeout);
							handshakePhase = "ready";
							this.log("backend.handshake_complete", { connId: conn.id });
							resolve();
						} else {
							clearTimeout(timeout);
							reject(new Error("Backend handshake rejected"));
						}
						return;
					}

					// Post-handshake: relay res/event frames to client
					if (handshakePhase !== "ready") return;

					if (frame.type === "event") {
						const eventName = frame.event as string | undefined;
						const eventNamespace = eventName?.split(".")[0];
						if (eventNamespace && !conn.granted.includes(eventNamespace)) {
							return;
						}
						const relay: RelayMessage = {
							type: "relay",
							event: eventName,
							params: frame.params as Record<string, unknown> | undefined,
						};
						ws.send(JSON.stringify(relay));
					} else if (frame.type === "res") {
						const relay: RelayMessage = {
							type: "relay",
							result: frame.payload,
							id: frame.id as string | undefined,
						};
						if (frame.error) {
							ws.send(
								JSON.stringify({
									type: "relay",
									id: frame.id,
									error: frame.error,
								}),
							);
						} else {
							ws.send(JSON.stringify(relay));
						}
					}
				} catch {
					// Drop unparseable backend messages
				}
			};

			backend.onclose = () => {
				this.log("backend.disconnected", { connId: conn.id });
				if (conn.state === "active") {
					this.sendError(ws, "backend_closed", "Backend disconnected");
					ws.close(4502, "Backend disconnected");
					this.cleanup(conn.id);
				}
			};
		});
	}

	// --- Utilities ---

	private generateNonce(): string {
		const bytes = new Uint8Array(32);
		crypto.getRandomValues(bytes);
		return btoa(String.fromCharCode(...bytes));
	}

	private async verifyPoW(
		nonce: string,
		solution: string,
		difficulty: number,
	): Promise<boolean> {
		const input = new TextEncoder().encode(nonce + solution);
		const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
		return checkLeadingZeroBits(hash, difficulty);
	}

	private checkRateLimit(conn: BridgeConnection): boolean {
		const now = Date.now();
		if (now - conn.messageWindowStart > RATE_LIMIT_WINDOW_MS) {
			conn.messageWindowStart = now;
			conn.messageCount = 1;
			return true;
		}
		conn.messageCount++;
		return conn.messageCount <= RATE_LIMIT_MAX;
	}

	private resetIdleTimer(
		conn: BridgeConnection,
		ws: ServerWebSocket<WsData>,
	): void {
		if (conn.idleTimer) clearTimeout(conn.idleTimer);
		conn.idleTimer = setTimeout(() => {
			this.log("connection.idle_timeout", { connId: conn.id });
			this.sendError(ws, "idle_timeout", "Connection idle timeout");
			ws.close(4408, "Idle timeout");
			this.cleanup(conn.id);
		}, IDLE_TIMEOUT_MS);
	}

	private sendError(
		ws: ServerWebSocket<WsData>,
		type: string,
		message: string,
	): void {
		try {
			const err: ErrorMessage = { error: { type, message } };
			ws.send(JSON.stringify(err));
		} catch {
			// Connection may already be closed
		}
	}

	private cleanup(connId: string): void {
		const conn = this.connections.get(connId);
		if (!conn) return;

		conn.state = "closed";
		if (conn.negotiationTimer) clearTimeout(conn.negotiationTimer);
		if (conn.idleTimer) clearTimeout(conn.idleTimer);
		if (conn.heartbeatTimer) clearInterval(conn.heartbeatTimer);
		if (conn.backendWs) {
			try {
				conn.backendWs.close();
			} catch {
				// Ignore
			}
		}
		this.connections.delete(connId);
	}

	private log(event: string, data: Record<string, unknown>): void {
		console.log(
			JSON.stringify({
				ts: new Date().toISOString(),
				event: `bridge.${event}`,
				...data,
			}),
		);
	}
}

/** Checks if a SHA-256 hash has at least `bits` leading zero bits. Bit-level precision. */
export function checkLeadingZeroBits(hash: Uint8Array, bits: number): boolean {
	let remaining = bits;
	for (let i = 0; remaining > 0 && i < hash.length; i++) {
		const byte = hash[i] ?? 0;
		if (remaining >= 8) {
			if (byte !== 0) return false;
			remaining -= 8;
		} else {
			const mask = 0xff << (8 - remaining);
			if ((byte & mask) !== 0) return false;
			remaining = 0;
		}
	}
	return true;
}

/**
 * Solve a PoW challenge (for clients and tests).
 * Finds a string `solution` such that SHA-256(nonce + solution) has
 * `difficulty` leading zero bits.
 */
export async function solveChallenge(
	nonce: string,
	difficulty: number,
): Promise<string> {
	let counter = 0;
	while (true) {
		const solution = counter.toString();
		const input = new TextEncoder().encode(nonce + solution);
		const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
		if (checkLeadingZeroBits(hash, difficulty)) {
			return solution;
		}
		counter++;
	}
}
