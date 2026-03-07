/**
 * @file types.ts
 * Shared types, message schemas, and constants for the WebSocket bridge.
 * Experiment-only – isolated in experiments/ws-bridge.
 *
 * @license Apache-2.0
 */

/** Agent trust levels governing bridge capability access. */
export type TrustLevel = "read" | "write" | "admin";

/** Runtime representation of an authenticated agent. */
export interface AgentPrincipal {
	id: string;
	name: string;
	trustLevel: TrustLevel;
}

/** Stored agent credential (in-memory for prototype, DB in production). */
export interface AgentCredential {
	id: string;
	name: string;
	keyHash: string;
	trustLevel: TrustLevel;
	revokedAt: string | null;
	expiresAt: string | null;
}

/** WebSocket data attached during upgrade, shared by index.ts and relay.ts. */
export interface WsData {
	connId: string;
	agent?: AgentPrincipal;
}

/** Client -> Server: PoW solution and requested capabilities. */
export interface NegotiateResponse {
	type: "negotiate";
	solution: string;
	capabilities: string[];
}

/** Server -> Client: negotiation succeeded, includes granted capabilities. */
export interface NegotiatedMessage {
	type: "negotiated";
	granted: string[];
	sessionKey: string;
}

/** Error envelope for denied operations or protocol violations. */
export interface ErrorMessage {
	error: {
		type: string;
		message: string;
	};
}

/** Bidirectional relay message wrapping JSON-RPC style calls/events. */
export interface RelayMessage {
	type: "relay";
	method?: string;
	event?: string;
	params?: Record<string, unknown>;
	id?: string;
	result?: unknown;
}

/** Per-connection bridge state tracking negotiation, capabilities, and timers. */
export interface BridgeConnection {
	id: string;
	agent: AgentPrincipal;
	state: "awaiting_negotiation" | "active" | "closed";
	granted: string[];
	session: string;
	nonce: string;
	difficulty: number;
	backendWs: WebSocket | null;
	lastActivity: number;
	messageCount: number;
	messageWindowStart: number;
	negotiationTimer: ReturnType<typeof setTimeout> | null;
	idleTimer: ReturnType<typeof setTimeout> | null;
	heartbeatTimer: ReturnType<typeof setInterval> | null;
	credentialCheckFailures: number;
}

/** Trust level -> allowed capability namespaces. */
export const TRUST_CAPABILITIES: Record<TrustLevel, string[]> = {
	admin: ["chat", "agent", "presence", "health", "system"],
	write: ["chat", "agent", "presence", "health"],
	read: ["chat", "health"],
};

/** Timing constants (ms). */
export const NEGOTIATION_TIMEOUT_MS = 5_000;
export const IDLE_TIMEOUT_MS = 30 * 60_000;
export const RATE_LIMIT_WINDOW_MS = 1_000;
export const RATE_LIMIT_MAX = 10;
export const MAX_MESSAGE_BYTES = 1024 * 1024; // 1 MiB per frame

/** Heartbeat constants matching core ws/handler.ts intervals. */
export const HEARTBEAT_INTERVAL_MS = 25_000;
export const HEARTBEAT_TIMEOUT_MS = 90_000;
export const MAX_CREDENTIAL_CHECK_FAILURES = 3;

/** Adaptive PoW escalation configuration (see ADR-008 for core's approach). */
export interface AdaptivePoWConfig {
	baseDifficulty: number;
	highDifficulty: number;
	pressureThreshold: number;
	highPressureThreshold: number;
	windowMs: number;
}

/** Default escalation curve: 8 bits base, 16 bits under high pressure. */
export const POW_DEFAULTS: AdaptivePoWConfig = {
	baseDifficulty: 8,
	highDifficulty: 16,
	pressureThreshold: 10,
	highPressureThreshold: 25,
	windowMs: 60_000,
};

/** Nonce TTL for seen-set dedup. Nonces older than this are pruned. */
export const NONCE_TTL_MS = 30_000;
