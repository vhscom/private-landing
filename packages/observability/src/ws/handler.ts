/**
 * @file handler.ts
 * WebSocket connection handler implementing capability negotiation and RPC dispatch (ADR-009).
 * Encapsulates the negotiation state machine, message dispatch, and subscription lifecycle.
 *
 * @license Apache-2.0
 */

import type { CacheClientFactory } from "@private-landing/infrastructure";
import { createDbClient } from "@private-landing/infrastructure";
import type { Env } from "@private-landing/types";
import type { WSContext } from "hono/ws";
import { nanoid } from "nanoid";
import { processEvent } from "../process-event";
import type { AgentPrincipal, TrustLevel } from "../types";
import {
	type Capability,
	CloseCodes,
	type InboundMessage,
	inboundMessageSchema,
} from "./schemas";

/**
 * Dependencies injected from the router's upgrade callback.
 * @property env - Worker environment bindings
 * @property ipAddress - Client IP for audit trail
 * @property ua - User-Agent string for audit trail
 * @property createCacheClient - Cache factory for session revocation cache invalidation
 */
export interface WsHandlerDeps {
	env: Env;
	ipAddress: string;
	ua: string;
	createCacheClient?: CacheClientFactory;
}

/** Capabilities available at each trust level. */
const READ_CAPABILITIES: ReadonlySet<Capability> = new Set([
	"query_events",
	"query_sessions",
	"subscribe_events",
]);

const WRITE_CAPABILITIES: ReadonlySet<Capability> = new Set(["revoke_session"]);

function allowedCapabilities(trustLevel: TrustLevel): ReadonlySet<Capability> {
	if (trustLevel === "write") {
		return new Set([...READ_CAPABILITIES, ...WRITE_CAPABILITIES]);
	}
	return READ_CAPABILITIES;
}

const HANDSHAKE_TIMEOUT_MS = 5_000;
const SUBSCRIPTION_INTERVAL_MS = 5_000;
const MSG_RATE_WINDOW_MS = 60_000;
const MSG_RATE_MAX = 60;
const MAX_CONCURRENT_SUBSCRIPTIONS = 50;
const PING_INTERVAL_MS = 25_000;
const PING_TIMEOUT_MS = 90_000;
const MAX_CREDENTIAL_CHECK_FAILURES = 3;
const SUBSCRIPTION_POLL_LIMIT = 100;

/** Global count of active subscriptions across all connections in this isolate. */
let activeSubscriptionCount = 0;

/** Per-connection subscription state for subscribe_events. */
interface Subscription {
	interval: ReturnType<typeof setInterval>;
	types: string[] | null; // null = all types
	highWaterMark: string; // ISO-8601 timestamp
}

/**
 * Create a WebSocket event handler for the given authenticated agent.
 * Returns the Hono WSEvents shape including `onOpen` for eager ws capture.
 */
export function createWsHandler(
	principal: AgentPrincipal,
	deps: WsHandlerDeps,
): {
	onOpen: (evt: Event, ws: WSContext<WebSocket>) => void;
	onMessage: (evt: MessageEvent, ws: WSContext<WebSocket>) => void;
	onClose: (evt: CloseEvent, ws: WSContext<WebSocket>) => void;
} {
	const connectionId = nanoid();
	const granted = new Set<Capability>();
	let negotiated = false;
	let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
	let subscription: Subscription | null = null;
	const msgTimestamps: number[] = [];
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	let lastClientActivity: number = Date.now();
	let closing = false;
	let credentialCheckFailures = 0;
	let wsRef: WSContext<WebSocket> | null = null;

	// Start the handshake deadline eagerly at handler creation (upgrade time).
	// onOpen is called explicitly by the router after accept(), so wsRef is
	// always set before the timer fires.
	handshakeTimer = setTimeout(() => {
		if (!negotiated && wsRef) {
			closeWith(wsRef, CloseCodes.HANDSHAKE_TIMEOUT, "Handshake timeout");
		}
	}, HANDSHAKE_TIMEOUT_MS);

	function clearHandshakeTimer(): void {
		if (handshakeTimer !== null) {
			clearTimeout(handshakeTimer);
			handshakeTimer = null;
		}
	}

	function send(ws: WSContext<WebSocket>, payload: unknown): void {
		if (closing) return;
		ws.send(JSON.stringify(payload));
	}

	function closeWith(
		ws: WSContext<WebSocket>,
		code: number,
		reason: string,
	): void {
		closing = true;
		ws.close(code, reason);
	}

	function sendError(
		ws: WSContext<WebSocket>,
		type: string,
		id: string,
		code: string,
		message: string,
	): void {
		send(ws, { type, id, ok: false, error: { code, message } });
	}

	/** Fire-and-forget event emission. Never blocks or throws. */
	function emit(type: string, detail?: Record<string, unknown>): void {
		processEvent(
			{
				type,
				created_at: new Date().toISOString(),
				ipAddress: deps.ipAddress,
				ua: deps.ua,
				status: 200,
				actorId: `agent:${principal.name}`,
				detail: { connectionId, ...detail },
			},
			{ env: deps.env },
		).catch((err) => console.error("[obs] ws event emit failed:", err));
	}

	/** Check credential validity. Returns true if valid, false if revoked (and closes the connection). Fail-open on DB error. */
	async function checkCredentialValidity(
		ws: WSContext<WebSocket>,
	): Promise<boolean> {
		try {
			const db = createDbClient(deps.env);
			const result = await db.execute({
				sql: "SELECT revoked_at FROM agent_credential WHERE id = ?",
				args: [principal.id],
			});

			if (result.rows.length === 0) {
				emit("ws.credential_revoked", { reason: "credential_not_found" });
				send(ws, {
					type: "credential.revoked",
					reason: "credential_not_found",
					guidance: "Re-authenticate with a valid agent key",
				});
				console.log(
					`[obs] ws forced close: credential not found (agent: ${principal.name}, conn: ${connectionId})`,
				);
				closeWith(ws, CloseCodes.CREDENTIAL_REVOKED, "Credential not found");
				return false;
			}

			const row = result.rows[0] as unknown as {
				revoked_at: string | null;
			};
			if (row.revoked_at !== null) {
				emit("ws.credential_revoked", { reason: "key_revoked" });
				send(ws, {
					type: "credential.revoked",
					reason: "key_revoked",
					guidance: "Re-authenticate with a new agent key",
				});
				console.log(
					`[obs] ws forced close: key revoked (agent: ${principal.name}, conn: ${connectionId})`,
				);
				closeWith(ws, CloseCodes.CREDENTIAL_REVOKED, "Credential revoked");
				return false;
			}

			credentialCheckFailures = 0;
			return true;
		} catch (err) {
			credentialCheckFailures++;
			console.error(
				`[obs] ws credential check failed (${credentialCheckFailures}/${MAX_CREDENTIAL_CHECK_FAILURES}):`,
				err,
			);
			if (credentialCheckFailures >= MAX_CREDENTIAL_CHECK_FAILURES) {
				emit("ws.credential_revoked", {
					reason: "credential_check_unavailable",
				});
				send(ws, {
					type: "credential.revoked",
					reason: "credential_check_unavailable",
					guidance: "Reconnect when the service is available",
				});
				closeWith(
					ws,
					CloseCodes.CREDENTIAL_REVOKED,
					"Credential check unavailable",
				);
				return false;
			}
			return true;
		}
	}

	function handleCapabilitiesRequest(
		msg: Extract<InboundMessage, { type: "capability.request" }>,
		ws: WSContext<WebSocket>,
	): void {
		const allowed = allowedCapabilities(principal.trustLevel);
		const allKnown = new Set([...READ_CAPABILITIES, ...WRITE_CAPABILITIES]);
		const denied: { capability: string; reason: string }[] = [];

		// Deduplicate requested capabilities
		const unique = [...new Set(msg.capabilities)];

		for (const cap of unique) {
			if (!allKnown.has(cap as Capability)) {
				denied.push({ capability: cap, reason: "unknown capability" });
			} else if (allowed.has(cap as Capability)) {
				granted.add(cap as Capability);
			} else {
				denied.push({ capability: cap, reason: "requires write trust level" });
			}
		}

		negotiated = true;
		clearHandshakeTimer();

		send(ws, {
			type: "capability.granted",
			connection_id: connectionId,
			agent: principal.name,
			granted: [...granted],
			denied,
		});

		for (const cap of granted) {
			emit("capability.granted", { capability: cap });
		}
		for (const entry of denied) {
			emit("capability.denied", entry);
		}

		emit("ws.connect", { agent: principal.name });

		// Unified heartbeat: credential re-validation + idle detection + keepalive
		heartbeatTimer = setInterval(async () => {
			if (Date.now() - lastClientActivity > PING_TIMEOUT_MS) {
				console.log(
					`[obs] ws forced close: ping timeout (agent: ${principal.name}, conn: ${connectionId})`,
				);
				closeWith(ws, CloseCodes.PING_TIMEOUT, "Ping timeout");
				return;
			}
			const valid = await checkCredentialValidity(ws);
			if (!valid) return;
			send(ws, {
				type: "heartbeat",
				ts: Date.now(),
				next_check_ms: PING_INTERVAL_MS,
				ping_timeout_ms: PING_TIMEOUT_MS,
				capabilities: [...granted],
			});
		}, PING_INTERVAL_MS);
	}

	function handlePing(
		msg: Extract<InboundMessage, { type: "ping" }>,
		ws: WSContext<WebSocket>,
	): void {
		send(ws, {
			type: "pong",
			...(msg.id != null ? { id: msg.id } : {}),
			ok: true,
		});
	}

	async function handleQueryEvents(
		msg: Extract<InboundMessage, { type: "query_events" }>,
		ws: WSContext<WebSocket>,
	): Promise<void> {
		const { payload } = msg;
		const since =
			payload.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

		const clauses: string[] = ["created_at >= ?"];
		const args: (string | number)[] = [since];

		if (payload.event_type) {
			clauses.push("type = ?");
			args.push(payload.event_type);
		}
		if (payload.user_id != null) {
			clauses.push("user_id = ?");
			args.push(payload.user_id);
		}
		if (payload.ip) {
			clauses.push("ip_address = ?");
			args.push(payload.ip);
		}
		if (payload.actor_id) {
			clauses.push("actor_id = ?");
			args.push(payload.actor_id);
		}

		try {
			const db = createDbClient(deps.env);
			const where = clauses.join(" AND ");

			if (payload.aggregate) {
				const result = await db.execute({
					sql: `SELECT type, COUNT(*) as count FROM security_event WHERE ${where} GROUP BY type`,
					args,
				});
				const stats: Record<string, number> = {};
				for (const row of result.rows) {
					const r = row as unknown as { type: string; count: number };
					stats[r.type] = r.count;
				}
				send(ws, {
					type: "query_events",
					id: msg.id,
					ok: true,
					payload: { since, stats },
				});
				return;
			}

			const limit = payload.limit ?? 50;
			const offset = payload.offset ?? 0;
			const result = await db.execute({
				sql: `SELECT id, type, ip_address, user_id, detail, created_at, actor_id FROM security_event WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
				args: [...args, limit, offset],
			});
			send(ws, {
				type: "query_events",
				id: msg.id,
				ok: true,
				payload: { events: result.rows, count: result.rows.length },
			});
		} catch (err) {
			console.error("[obs] ws query_events failed:", err);
			sendError(ws, msg.type, msg.id, "INTERNAL_ERROR", "Query failed");
		}
	}

	async function handleQuerySessions(
		msg: Extract<InboundMessage, { type: "query_sessions" }>,
		ws: WSContext<WebSocket>,
	): Promise<void> {
		const { payload } = msg;
		const activeOnly = payload.active !== false;
		const limit = payload.limit ?? 50;
		const offset = payload.offset ?? 0;

		const clauses: string[] = [];
		const args: (string | number)[] = [];

		if (activeOnly) {
			clauses.push("expires_at > datetime('now')");
		}
		if (payload.user_id != null) {
			clauses.push("user_id = ?");
			args.push(payload.user_id);
		}

		try {
			const db = createDbClient(deps.env);
			const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
			const result = await db.execute({
				sql: `SELECT id, user_id, ip_address, user_agent, created_at, expires_at FROM session ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
				args: [...args, limit, offset],
			});
			send(ws, {
				type: "query_sessions",
				id: msg.id,
				ok: true,
				payload: { sessions: result.rows, count: result.rows.length },
			});
		} catch (err) {
			console.error("[obs] ws query_sessions failed:", err);
			sendError(ws, msg.type, msg.id, "INTERNAL_ERROR", "Query failed");
		}
	}

	async function handleRevokeSession(
		msg: Extract<InboundMessage, { type: "revoke_session" }>,
		ws: WSContext<WebSocket>,
	): Promise<void> {
		const { scope } = msg.payload;
		const targetId =
			"target_id" in msg.payload ? msg.payload.target_id : undefined;
		const db = createDbClient(deps.env);
		let revoked = 0;
		let affectedUserIds: string[] = [];

		try {
			switch (scope) {
				case "user": {
					const result = await db.execute({
						sql: "UPDATE session SET expires_at = datetime('now') WHERE user_id = ? AND expires_at > datetime('now')",
						args: [Number(targetId)],
					});
					revoked = result.rowsAffected;
					break;
				}
				case "session": {
					const result = await db.execute({
						sql: "UPDATE session SET expires_at = datetime('now') WHERE id = ? AND expires_at > datetime('now')",
						args: [String(targetId)],
					});
					revoked = result.rowsAffected;
					break;
				}
				case "all": {
					// Pre-collect affected user IDs for cache invalidation
					if (deps.createCacheClient) {
						try {
							const rows = await db.execute(
								"SELECT DISTINCT user_id FROM session WHERE expires_at > datetime('now')",
							);
							affectedUserIds = rows.rows.map((r) => String(r.user_id));
						} catch {
							// Best-effort — proceed with SQL revocation regardless
						}
					}
					const result = await db.execute(
						"UPDATE session SET expires_at = datetime('now') WHERE expires_at > datetime('now')",
					);
					revoked = result.rowsAffected;
					break;
				}
			}
		} catch (err) {
			console.error("[obs] ws revoke_session failed:", err);
			sendError(ws, msg.type, msg.id, "INTERNAL_ERROR", "Revocation failed");
			return;
		}

		// Best-effort cache invalidation
		if (deps.createCacheClient) {
			try {
				const cache = deps.createCacheClient(deps.env);
				switch (scope) {
					case "user": {
						const uid = String(targetId);
						const sids = await cache.smembers(`user_sessions:${uid}`);
						for (const sid of sids) {
							await cache.del(`session:${sid}`);
						}
						await cache.del(`user_sessions:${uid}`);
						break;
					}
					case "session": {
						const sid = String(targetId);
						const raw = await cache.get(`session:${sid}`);
						if (raw) {
							const session = JSON.parse(raw) as { userId: number };
							const uid = String(session.userId);
							await cache.srem(`user_sessions:${uid}`, sid);
						}
						await cache.del(`session:${sid}`);
						break;
					}
					case "all": {
						for (const uid of affectedUserIds) {
							const sids = await cache.smembers(`user_sessions:${uid}`);
							for (const sid of sids) {
								await cache.del(`session:${sid}`);
							}
							await cache.del(`user_sessions:${uid}`);
						}
						break;
					}
				}
			} catch (err) {
				console.error("[obs] ws cache cleanup error:", err);
			}
		}

		send(ws, {
			type: "revoke_session",
			id: msg.id,
			ok: true,
			payload: { revoked },
		});

		emit("session.ops_revoke", {
			scope,
			...(targetId != null ? { id: targetId } : {}),
			revoked,
		});
	}

	function handleSubscribeEvents(
		msg: Extract<InboundMessage, { type: "subscribe_events" }>,
		ws: WSContext<WebSocket>,
	): void {
		if (subscription !== null) {
			sendError(
				ws,
				msg.type,
				msg.id,
				"SUBSCRIPTION_ACTIVE",
				"A subscription is already active; send unsubscribe_events first",
			);
			return;
		}

		if (activeSubscriptionCount >= MAX_CONCURRENT_SUBSCRIPTIONS) {
			sendError(
				ws,
				msg.type,
				msg.id,
				"SUBSCRIPTION_LIMIT",
				"Global subscription limit reached; try again later",
			);
			return;
		}

		activeSubscriptionCount++;
		const types = msg.payload.types ?? null;
		const highWaterMark = new Date().toISOString();

		const interval = setInterval(async () => {
			try {
				const db = createDbClient(deps.env);
				const clauses: string[] = ["created_at > ?"];
				const args: (string | number)[] = [
					subscription?.highWaterMark ?? highWaterMark,
				];

				if (subscription?.types) {
					const exact: string[] = [];
					const wildcards: string[] = [];
					for (const t of subscription.types) {
						if (t.endsWith(".*")) {
							wildcards.push(`${t.slice(0, -1)}%`);
						} else {
							exact.push(t);
						}
					}
					const parts: string[] = [];
					if (exact.length > 0) {
						parts.push(`type IN (${exact.map(() => "?").join(", ")})`);
						args.push(...exact);
					}
					for (const w of wildcards) {
						parts.push("type LIKE ?");
						args.push(w);
					}
					clauses.push(`(${parts.join(" OR ")})`);
				}

				const where = clauses.join(" AND ");
				const result = await db.execute({
					sql: `SELECT id, type, ip_address, user_id, detail, created_at, actor_id FROM security_event WHERE ${where} ORDER BY created_at ASC LIMIT ${SUBSCRIPTION_POLL_LIMIT}`,
					args,
				});

				for (const row of result.rows) {
					const r = row as unknown as {
						id: number;
						type: string;
						ip_address: string;
						user_id: number | null;
						detail: string | null;
						created_at: string;
						actor_id: string | null;
					};
					let detail: unknown = null;
					if (r.detail) {
						try {
							detail = JSON.parse(r.detail);
						} catch {
							detail = r.detail;
						}
					}
					send(ws, {
						type: "event",
						payload: {
							event_id: r.id,
							event_type: r.type,
							ip_address: r.ip_address,
							user_id: r.user_id,
							detail,
							created_at: r.created_at,
							actor_id: r.actor_id,
						},
					});
				}

				if (result.rows.length > 0) {
					const lastRow = result.rows[result.rows.length - 1] as unknown as {
						created_at: string;
					};
					if (subscription) {
						subscription.highWaterMark = lastRow.created_at;
					}
				}

				if (result.rows.length >= SUBSCRIPTION_POLL_LIMIT) {
					send(ws, {
						type: "subscription.backpressure",
						count: result.rows.length,
						limit: SUBSCRIPTION_POLL_LIMIT,
					});
				}
			} catch (err) {
				console.error("[obs] ws subscription poll failed:", err);
			}
		}, SUBSCRIPTION_INTERVAL_MS);

		subscription = { interval, types, highWaterMark };

		send(ws, {
			type: "subscribe_events",
			id: msg.id,
			ok: true,
			payload: { interval_ms: SUBSCRIPTION_INTERVAL_MS },
		});
	}

	function handleUnsubscribeEvents(
		msg: Extract<InboundMessage, { type: "unsubscribe_events" }>,
		ws: WSContext<WebSocket>,
	): void {
		if (subscription !== null) {
			clearInterval(subscription.interval);
			subscription = null;
			activeSubscriptionCount = Math.max(0, activeSubscriptionCount - 1);
		}
		send(ws, { type: "unsubscribe_events", id: msg.id, ok: true });
	}

	/** Capability-gated message types (ping and capability.request are ungated). */
	const GATED_TYPES = new Set<string>([
		"query_events",
		"query_sessions",
		"subscribe_events",
		"unsubscribe_events",
		"revoke_session",
	]);

	return {
		onOpen(_evt, ws) {
			wsRef = ws;
		},

		onMessage(evt, ws) {
			// Track client activity for idle detection
			lastClientActivity = Date.now();

			// Per-connection message rate limiting (sliding window)
			const now = Date.now();
			msgTimestamps.push(now);
			while (
				msgTimestamps.length > 0 &&
				msgTimestamps[0] <= now - MSG_RATE_WINDOW_MS
			) {
				msgTimestamps.shift();
			}
			if (msgTimestamps.length > MSG_RATE_MAX) {
				emit("rate_limit.reject", {
					limit: "ws:message",
				});
				closeWith(ws, CloseCodes.RATE_LIMITED, "Message rate exceeded");
				clearHandshakeTimer();
				return;
			}

			let raw: unknown;
			try {
				raw = JSON.parse(
					typeof evt.data === "string" ? evt.data : String(evt.data),
				);
			} catch {
				closeWith(ws, CloseCodes.PROTOCOL_ERROR, "Invalid JSON");
				clearHandshakeTimer();
				return;
			}

			const result = inboundMessageSchema.safeParse(raw);
			if (!result.success) {
				// If not negotiated, any parse failure is a protocol error
				if (!negotiated) {
					closeWith(ws, CloseCodes.PROTOCOL_ERROR, "Invalid message");
					clearHandshakeTimer();
					return;
				}
				// After negotiation, send an error response if we can extract type/id
				const obj = raw as Record<string, unknown>;
				send(ws, {
					type: obj.type ?? "unknown",
					id: obj.id ?? "unknown",
					ok: false,
					error: {
						code: "INVALID_PAYLOAD",
						message: "Message validation failed",
					},
				});
				return;
			}

			const msg = result.data;

			if (!negotiated) {
				if (msg.type === "capability.request") {
					handleCapabilitiesRequest(msg, ws);
				} else {
					closeWith(
						ws,
						CloseCodes.PROTOCOL_ERROR,
						"Expected capability.request",
					);
					clearHandshakeTimer();
				}
				return;
			}

			// Post-negotiation dispatch

			// Capability gate: check if this message type requires a granted capability
			if (GATED_TYPES.has(msg.type)) {
				// unsubscribe_events requires subscribe_events capability
				const requiredCap =
					msg.type === "unsubscribe_events"
						? "subscribe_events"
						: (msg.type as Capability);
				if (!granted.has(requiredCap)) {
					const m = msg as { type: string; id: string };
					emit("ws.unauthorized", { type: m.type });
					sendError(
						ws,
						m.type,
						m.id,
						"CAPABILITY_NOT_GRANTED",
						`Capability '${requiredCap}' was not granted`,
					);
					return;
				}
			}

			switch (msg.type) {
				case "ping":
					handlePing(msg, ws);
					break;
				case "capability.request":
					// Re-negotiation not allowed — echo connection_id so the client can recover it
					send(ws, {
						type: "capability.request",
						connection_id: connectionId,
						ok: false,
						error: {
							code: "ALREADY_NEGOTIATED",
							message: "Already negotiated",
						},
					});
					break;
				case "query_events":
					handleQueryEvents(msg, ws);
					break;
				case "query_sessions":
					handleQuerySessions(msg, ws);
					break;
				case "subscribe_events":
					handleSubscribeEvents(msg, ws);
					break;
				case "unsubscribe_events":
					handleUnsubscribeEvents(msg, ws);
					break;
				case "revoke_session":
					handleRevokeSession(msg, ws);
					break;
			}
		},

		onClose(evt) {
			clearHandshakeTimer();
			if (heartbeatTimer !== null) {
				clearInterval(heartbeatTimer);
				heartbeatTimer = null;
			}
			if (subscription !== null) {
				clearInterval(subscription.interval);
				subscription = null;
				activeSubscriptionCount = Math.max(0, activeSubscriptionCount - 1);
			}
			emit("ws.disconnect", { code: evt.code, reason: evt.reason });
			console.log(
				`[obs] ws closed (agent: ${principal.name}, conn: ${connectionId})`,
			);
		},
	};
}

/** Reset global subscription counter. Exported for testing only. @internal */
export function _resetSubscriptionCount(): void {
	activeSubscriptionCount = 0;
}
