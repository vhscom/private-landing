/**
 * @file types.ts
 * Types and constants for the control WebSocket proxy (ADR-010).
 * Plugin-only – removable with packages/control.
 *
 * @license Apache-2.0
 */

/**
 * JWT-synthesized identity for proxy connections.
 * @property id - Composite identifier in `user:${uid}` format
 * @property name - Display name in `user-${uid}` format
 * @property uid - User ID from the JWT `uid` claim
 * @property sid - Session ID from the JWT `sid` claim (used for heartbeat re-validation)
 */
export interface BridgePrincipal {
	id: string;
	name: string;
	uid: number;
	sid: string;
}

/**
 * Per-connection proxy state.
 *
 * State machine: `connecting` → `active` → `closed`.
 * Transitions are one-way; `closed` is terminal and triggers cleanup.
 *
 * @property id - Unique connection ID (nanoid)
 * @property principal - Authenticated identity for this connection
 * @property state - Current lifecycle phase
 * @property backendWs - Gateway WebSocket (null until handshake completes)
 * @property lastActivity - Epoch ms of last inbound message (drives ping timeout)
 * @property messageCount - Messages received in the current rate-limit window
 * @property messageWindowStart - Epoch ms when the current rate-limit window opened
 * @property pendingMessages - Messages buffered while backend is connecting
 */
export interface ProxyConnection {
	id: string;
	principal: BridgePrincipal;
	state: "connecting" | "active" | "closed";
	backendWs: WebSocket | null;
	lastActivity: number;
	messageCount: number;
	messageWindowStart: number;
	pendingMessages: string[];
	idleTimer: ReturnType<typeof setTimeout> | null;
	heartbeatTimer: ReturnType<typeof setInterval> | null;
}

/** Maximum inactivity (ms) before the connection is closed. */
export const IDLE_TIMEOUT_MS = 30 * 60_000;
/** Fixed-window duration (ms) for per-connection rate limiting. */
export const RATE_LIMIT_WINDOW_MS = 1_000;
/** Maximum messages allowed per rate-limit window. */
export const RATE_LIMIT_MAX = 10;
/** Maximum inbound message size in bytes. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;
/** Maximum messages buffered while backend is connecting. */
export const MAX_PENDING_MESSAGES = 20;

/** Interval (ms) between heartbeat pings with session re-validation. */
export const HEARTBEAT_INTERVAL_MS = 25_000;
/** Inactivity threshold (ms) after which the connection is considered dead. */
export const HEARTBEAT_TIMEOUT_MS = 90_000;

/** WebSocket close codes (RFC 6455 private-use range). */
export const CloseCodes = {
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
