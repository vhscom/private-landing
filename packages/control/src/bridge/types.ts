/**
 * @file types.ts
 * Bridge-specific types and constants for the control WebSocket relay (ADR-010).
 * Plugin-only – removable with packages/control.
 *
 * @license Apache-2.0
 */

/**
 * JWT-synthesized identity for bridge connections.
 * @property id - Composite identifier in `user:${uid}` format
 * @property name - Display name in `user-${uid}` format
 * @property trustLevel - Trust tier controlling capability grants
 * @property uid - User ID from the JWT `uid` claim
 * @property sid - Session ID from the JWT `sid` claim (used for heartbeat re-validation)
 */
export interface BridgePrincipal {
	id: string;
	name: string;
	trustLevel: "admin";
	uid: number;
	sid: string;
}

/**
 * Client → Bridge: PoW solution and requested capabilities.
 * @property solution - Counter string satisfying SHA-256 leading-zero-bit challenge
 * @property capabilities - Gateway namespace names the client is requesting
 */
export interface NegotiateResponse {
	type: "negotiate";
	solution: string;
	capabilities: string[];
}

/**
 * Bridge → Client: negotiation succeeded.
 * @property granted - Capability namespaces the bridge authorized
 * @property sessionKey - Opaque key identifying the backend session
 */
export interface NegotiatedMessage {
	type: "negotiated";
	granted: string[];
	sessionKey: string;
}

/** Error envelope. */
export interface ErrorMessage {
	error: { type: string; message: string };
}

/**
 * Bidirectional relay message wrapping JSON-RPC style calls/events.
 * @property method - Namespaced RPC method (e.g. `chat.send`)
 * @property event - Namespaced event name (e.g. `presence.join`)
 * @property params - Arbitrary payload forwarded to the gateway
 * @property id - Correlation ID for request/response pairing
 * @property result - Response payload from the gateway (downstream only)
 * @property error - Error payload from the gateway (downstream only)
 */
export interface RelayMessage {
	type: "relay";
	method?: string;
	event?: string;
	params?: Record<string, unknown>;
	id?: string;
	result?: unknown;
	error?: unknown;
}

/**
 * Per-connection bridge state.
 *
 * State machine: `awaiting_negotiation` → `active` → `closed`.
 * Transitions are one-way; `closed` is terminal and triggers cleanup.
 *
 * @property id - Unique connection ID (nanoid)
 * @property principal - Authenticated identity for this connection
 * @property state - Current lifecycle phase
 * @property granted - Capability namespaces authorized after negotiation
 * @property sessionKey - Backend session key (set after negotiation)
 * @property nonce - PoW challenge nonce issued to the client
 * @property difficulty - Required leading zero bits for PoW verification
 * @property backendWs - Gateway WebSocket (null until handshake completes)
 * @property lastActivity - Epoch ms of last inbound message (drives ping timeout)
 * @property messageCount - Messages received in the current rate-limit window
 * @property messageWindowStart - Epoch ms when the current rate-limit window opened
 */
export interface BridgeConnection {
	id: string;
	principal: BridgePrincipal;
	state: "awaiting_negotiation" | "active" | "closed";
	granted: string[];
	sessionKey: string;
	nonce: string;
	difficulty: number;
	backendWs: WebSocket | null;
	lastActivity: number;
	messageCount: number;
	messageWindowStart: number;
	negotiationTimer: ReturnType<typeof setTimeout> | null;
	idleTimer: ReturnType<typeof setTimeout> | null;
	heartbeatTimer: ReturnType<typeof setInterval> | null;
}

/** Trust level → gateway capability namespaces the level may access. */
export const TRUST_CAPABILITIES: Record<string, string[]> = {
	admin: ["chat", "agent", "presence", "health", "system"],
	write: ["chat", "agent", "presence", "health"],
	read: ["chat", "health"],
};

/** Maximum time (ms) for the client to complete PoW negotiation. */
export const NEGOTIATION_TIMEOUT_MS = 5_000;
/** Maximum inactivity (ms) before the connection is closed. */
export const IDLE_TIMEOUT_MS = 30 * 60_000;
/** Fixed-window duration (ms) for per-connection rate limiting. */
export const RATE_LIMIT_WINDOW_MS = 1_000;
/** Maximum messages allowed per rate-limit window. */
export const RATE_LIMIT_MAX = 10;
/** Maximum inbound message size in bytes. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

/** Interval (ms) between heartbeat pings with session re-validation. */
export const HEARTBEAT_INTERVAL_MS = 25_000;
/** Inactivity threshold (ms) after which the connection is considered dead. */
export const HEARTBEAT_TIMEOUT_MS = 90_000;

/** Required SHA-256 leading zero bits for PoW verification. */
export const POW_DIFFICULTY = 8;

/** Nonce TTL (ms) for replay prevention. */
export const NONCE_TTL_MS = 30_000;

/** WebSocket close codes (RFC 6455 private-use range). */
export const CloseCodes = {
	/** Client did not complete PoW negotiation within the deadline. */
	NEGOTIATION_TIMEOUT: 4408,
	/** PoW solution failed SHA-256 leading-zero-bit verification. */
	INVALID_POW: 4403,
	/** No requested capabilities match the client's trust level. */
	NO_CAPABILITIES: 4403,
	/** Nonce was already consumed — replay detected. */
	NONCE_REPLAY: 4403,
	/** Gateway WebSocket could not be established. */
	BACKEND_UNAVAILABLE: 4502,
	/** Gateway WebSocket closed unexpectedly. */
	BACKEND_DISCONNECTED: 4502,
	/** Client unresponsive — no messages within heartbeat timeout. */
	PING_TIMEOUT: 4408,
	/** PL session expired or revoked during heartbeat re-validation. */
	SESSION_REVOKED: 4010,
	/** Connection closed due to inactivity. */
	IDLE_TIMEOUT: 4408,
	/** Replaced by a newer connection from the same user. */
	SUPERSEDED: 4012,
	/** Inbound message rate exceeded per-connection limit. */
	RATE_LIMITED: 4029,
} as const;
