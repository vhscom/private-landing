/** Agent trust levels governing bridge capability access. */
export type TrustLevel = "read" | "write";

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
}

/** WebSocket data attached during upgrade, shared by index.ts and relay.ts */
export interface WsData {
	connId: string;
	agent?: AgentPrincipal;
}

/** Client -> Server: respond to negotiation challenge */
export interface NegotiateResponse {
	type: "negotiate";
	solution: string;
	capabilities: string[];
}

/** Server -> Client: negotiation succeeded */
export interface NegotiatedMessage {
	type: "negotiated";
	granted: string[];
	session: string;
}

/** Error envelope for denied operations or protocol violations */
export interface ErrorMessage {
	error: {
		type: string;
		message: string;
	};
}

/** Bidirectional relay message wrapping JSON-RPC style calls/events */
export interface RelayMessage {
	type: "relay";
	method?: string;
	event?: string;
	params?: Record<string, unknown>;
	id?: string | number;
	result?: unknown;
}

/** Per-connection bridge state */
export interface BridgeConnection {
	id: string;
	agent: AgentPrincipal;
	state: "awaiting_negotiation" | "active" | "closed";
	granted: string[];
	session: string;
	nonce: string;
	backendWs: WebSocket | null;
	lastActivity: number;
	messageCount: number;
	messageWindowStart: number;
	negotiationTimer: ReturnType<typeof setTimeout> | null;
	idleTimer: ReturnType<typeof setTimeout> | null;
}

/** Trust level -> allowed capability namespaces */
export const TRUST_CAPABILITIES: Record<TrustLevel, string[]> = {
	write: ["chat", "agent", "presence", "health"],
	read: ["chat", "health"],
};

/** Timing constants (ms) */
export const NEGOTIATION_TIMEOUT_MS = 5_000;
export const IDLE_TIMEOUT_MS = 30 * 60_000;
export const RATE_LIMIT_WINDOW_MS = 1_000;
export const RATE_LIMIT_MAX = 10;
export const POW_DIFFICULTY = 8; // leading zero bits required
export const MAX_MESSAGE_BYTES = 1024 * 1024; // 1 MiB per frame
