import type { ServerWebSocket } from "bun";
import {
	type AgentPrincipal,
	type BridgeConnection,
	type ErrorMessage,
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
	type WsData,
} from "../types";

/**
 * BridgeRelay manages WebSocket connections, capability negotiation,
 * and bidirectional message relay to the backend.
 */
export class BridgeRelay {
	private connections = new Map<string, BridgeConnection>();
	private backendUrl: string;

	constructor(backendUrl: string) {
		this.backendUrl = backendUrl;
	}

	/** Called when a WebSocket connection opens after upgrade */
	handleOpen(ws: ServerWebSocket<WsData>, agent: AgentPrincipal): void {
		const connId = crypto.randomUUID();
		const nonce = this.generateNonce();

		const conn: BridgeConnection = {
			id: connId,
			agent,
			state: "awaiting_negotiation",
			granted: [],
			session: "",
			nonce,
			backendWs: null,
			lastActivity: Date.now(),
			messageCount: 0,
			messageWindowStart: Date.now(),
			negotiationTimer: null,
			idleTimer: null,
		};

		// Store connection ID without overwriting other ws.data fields
		ws.data.connId = connId;
		this.connections.set(connId, conn);

		this.log("connection.open", {
			connId,
			agent: agent.name,
			trustLevel: agent.trustLevel,
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

		// Send challenge
		const challenge = `PoW difficulty ${POW_DIFFICULTY}`;
		ws.send(
			JSON.stringify({
				type: "negotiate",
				nonce,
				challenge,
			}),
		);
	}

	/** Called for each incoming WebSocket message */
	async handleMessage(ws: ServerWebSocket<WsData>, raw: string): Promise<void> {
		const conn = this.connections.get(ws.data.connId);
		if (!conn) {
			ws.close(4000, "Unknown connection");
			return;
		}

		conn.lastActivity = Date.now();

		// Message size check
		if (raw.length > MAX_MESSAGE_BYTES) {
			this.sendError(
				ws,
				"message_too_large",
				`Max message size is ${MAX_MESSAGE_BYTES} bytes`,
			);
			return;
		}

		// Rate limiting
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

		if (conn.state === "active" && msg.type === "relay") {
			this.handleRelayToBackend(conn, ws, msg as RelayMessage);
			return;
		}

		this.sendError(ws, "protocol_error", "Unexpected message");
	}

	/** Called when a WebSocket connection closes */
	handleClose(ws: ServerWebSocket<WsData>): void {
		const connId = ws.data?.connId;
		if (connId) {
			this.log("connection.close", { connId });
			this.cleanup(connId);
		}
	}

	// --- Private ---

	private async handleNegotiateResponse(
		conn: BridgeConnection,
		ws: ServerWebSocket<WsData>,
		msg: NegotiateResponse,
	): Promise<void> {
		// Clear negotiation timer
		if (conn.negotiationTimer) {
			clearTimeout(conn.negotiationTimer);
			conn.negotiationTimer = null;
		}

		// Verify PoW solution
		const valid = await this.verifyPoW(conn.nonce, msg.solution);
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

		// Determine granted capabilities from trust level
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

		const session = `exp-${conn.agent.name}-${crypto.randomUUID().slice(0, 8)}`;
		conn.granted = granted;
		conn.session = session;
		conn.state = "active";

		// Start idle timeout
		this.resetIdleTimer(conn, ws);

		// Connect to backend
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
			session,
		};
		ws.send(JSON.stringify(response));

		this.log("negotiation.success", {
			connId: conn.id,
			agent: conn.agent.name,
			granted,
			session,
		});
	}

	private handleRelayToBackend(
		conn: BridgeConnection,
		ws: ServerWebSocket<WsData>,
		msg: RelayMessage,
	): void {
		this.resetIdleTimer(conn, ws);

		// Capability check: method "chat.send" requires "chat" capability
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

		// Forward to backend with session context
		const backendMsg = {
			method: msg.method,
			params: { ...msg.params, session: conn.session },
			id: msg.id,
		};
		conn.backendWs.send(JSON.stringify(backendMsg));
	}

	private connectBackend(
		conn: BridgeConnection,
		ws: ServerWebSocket<WsData>,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			const backend = new WebSocket(this.backendUrl);

			const timeout = setTimeout(() => {
				backend.close();
				reject(new Error("Backend connection timeout"));
			}, 5000);

			backend.onopen = () => {
				clearTimeout(timeout);
				conn.backendWs = backend;
				this.log("backend.connected", { connId: conn.id });
				resolve();
			};

			backend.onerror = () => {
				clearTimeout(timeout);
				reject(new Error("Backend connection error"));
			};

			backend.onmessage = (ev) => {
				// Relay backend messages to client, filtered by capabilities
				try {
					const data = JSON.parse(String(ev.data)) as Record<string, unknown>;
					const eventNamespace =
						typeof data.event === "string"
							? data.event.split(".")[0]
							: undefined;

					if (eventNamespace && !conn.granted.includes(eventNamespace)) {
						// Silently drop events the client isn't subscribed to
						return;
					}

					const relay: RelayMessage = {
						type: "relay",
						event: data.event as string | undefined,
						result: data.result,
						id: data.id as string | number | undefined,
						params: data.params as Record<string, unknown> | undefined,
					};
					ws.send(JSON.stringify(relay));
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

	private generateNonce(): string {
		const bytes = new Uint8Array(32);
		crypto.getRandomValues(bytes);
		return btoa(String.fromCharCode(...bytes));
	}

	private async verifyPoW(nonce: string, solution: string): Promise<boolean> {
		const input = new TextEncoder().encode(nonce + solution);
		const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
		return checkLeadingZeroBits(hash, POW_DIFFICULTY);
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

/** Check if a hash has at least `bits` leading zero bits */
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
