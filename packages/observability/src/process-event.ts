/**
 * @file process-event.ts
 * Direct event and challenge processing (ADR-008).
 * Plugin-only – removable by deleting packages/observability.
 *
 * @license Apache-2.0
 */

import { createDbClient } from "@private-landing/infrastructure";
import type { Env } from "@private-landing/types";
import { z } from "zod";
import { adaptiveDefaults, type ResolvedAdaptiveConfig } from "./config";
import { ensureSchema } from "./schema";

/** Default actor ID for application-generated events. */
export const APP_ACTOR_ID = "app:private-landing";

/** Well-known security event types. Consumers may define additional string types. */
export const EventTypes = {
	LOGIN_SUCCESS: "login.success",
	LOGIN_FAILURE: "login.failure",
	PASSWORD_CHANGE: "password.change",
	SESSION_REVOKE: "session.revoke",
	SESSION_REVOKE_ALL: "session.revoke_all",
	AGENT_AUTH_FAILURE: "agent.auth_failure",
	SESSION_OPS_REVOKE: "session.ops_revoke",
	AGENT_PROVISIONED: "agent.provisioned",
	AGENT_REVOKED: "agent.revoked",
} as const;

/** Structured security event for the observability pipeline. */
export interface SecurityEvent {
	type: string;
	created_at: string;
	userId?: number;
	ipAddress: string;
	ua: string;
	status: number;
	detail?: Record<string, unknown>;
	actorId?: string;
}

export const securityEventSchema = z.object({
	type: z.string().min(1),
	created_at: z.string(),
	userId: z.number().optional(),
	ipAddress: z.string(),
	ua: z.string(),
	status: z.number(),
	detail: z.record(z.string(), z.unknown()).optional(),
	actorId: z.string().optional(),
});

export interface ProcessEventDeps {
	env: Env;
}

/**
 * Process a security event directly — INSERT into security_event.
 * Always emits when called (no toggle).
 */
export async function processEvent(
	event: SecurityEvent,
	deps: ProcessEventDeps,
): Promise<void> {
	try {
		await ensureSchema(deps.env);
		const db = createDbClient(deps.env);
		await db.execute({
			sql: `INSERT INTO security_event (type, ip_address, user_id, user_agent, status, detail, created_at, actor_id)
				  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			args: [
				event.type,
				event.ipAddress,
				event.userId ?? null,
				event.ua,
				event.status,
				event.detail ? JSON.stringify(event.detail) : null,
				event.created_at,
				event.actorId ?? APP_ACTOR_ID,
			],
		});
	} catch (err) {
		console.error("[obs] security_event insert failed:", err);
	}
}

/** PoW challenge returned by computeChallenge when failures exceed threshold. */
export interface AdaptiveChallenge {
	type: string;
	difficulty: number;
	nonce: string;
}

/**
 * Query recent login failures for an IP and return a PoW challenge if needed.
 * Returns null when no challenge is required or on error (fail-open).
 */
export async function computeChallenge(
	ipAddress: string,
	env: Env,
	config: ResolvedAdaptiveConfig = adaptiveDefaults,
): Promise<AdaptiveChallenge | null> {
	const since = new Date(
		Date.now() - config.windowMinutes * 60 * 1000,
	).toISOString();
	let failures = 0;
	try {
		await ensureSchema(env);
		const db = createDbClient(env);
		const result = await db.execute({
			sql: "SELECT COUNT(*) as count FROM security_event WHERE type = 'login.failure' AND ip_address = ? AND created_at >= ?",
			args: [ipAddress, since],
		});
		failures = Number(result.rows[0]?.count ?? 0);
	} catch (err) {
		console.error("[obs] challenge query failed:", err);
		return null;
	}

	if (failures < config.failureThreshold) return null;

	const nonceBytes = new Uint8Array(16);
	crypto.getRandomValues(nonceBytes);
	const nonce = Array.from(nonceBytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	return {
		type: "pow",
		difficulty:
			failures >= config.highThreshold
				? config.highDifficulty
				: config.lowDifficulty,
		nonce,
	};
}
