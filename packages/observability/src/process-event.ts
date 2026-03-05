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
	CHALLENGE_ISSUED: "challenge.issued",
	CHALLENGE_FAILED: "challenge.failed",
	REGISTRATION_SUCCESS: "registration.success",
	REGISTRATION_FAILURE: "registration.failure",
	RATE_LIMITED: "rate_limit.reject",
	WS_CONNECT: "ws.connect",
	WS_CONNECT_FAILURE: "ws.connect_failure",
	WS_DISCONNECT: "ws.disconnect",
	WS_UNAUTHORIZED: "ws.unauthorized",
	WS_CREDENTIAL_REVOKED: "ws.credential_revoked",
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

/** Max age (ms) for a signed PoW nonce before it is considered expired. */
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * HMAC-sign a payload with the server secret (JWT_ACCESS_SECRET).
 * Returns the hex-encoded HMAC-SHA256 signature.
 */
async function hmacSign(secret: string, payload: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(payload),
	);
	return Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Build a signed composite nonce: `randomHex.timestamp.hmac`.
 * The HMAC covers `randomHex|timestamp|ipAddress` so the nonce is bound to
 * the requesting IP and cannot be forged or reused from a different context.
 */
async function buildSignedNonce(
	secret: string,
	ipAddress: string,
): Promise<string> {
	const nonceBytes = new Uint8Array(16);
	crypto.getRandomValues(nonceBytes);
	const random = Array.from(nonceBytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	const ts = Date.now().toString();
	const mac = await hmacSign(secret, `${random}|${ts}|${ipAddress}`);
	return `${random}.${ts}.${mac}`;
}

/**
 * Verify a signed composite nonce. Returns true only if:
 * 1. Format is `random.timestamp.hmac` (3 dot-separated parts)
 * 2. HMAC matches `random|timestamp|ipAddress` signed with the server secret
 * 3. Timestamp is within NONCE_TTL_MS of now
 */
export async function verifySignedNonce(
	nonce: string,
	secret: string,
	ipAddress: string,
): Promise<boolean> {
	const parts = nonce.split(".");
	if (parts.length !== 3) return false;
	const [random, ts, mac] = parts;
	const expected = await hmacSign(secret, `${random}|${ts}|${ipAddress}`);
	// Constant-length comparison (both are hex-encoded SHA-256 = 64 chars)
	if (mac.length !== expected.length) return false;
	let mismatch = 0;
	for (let i = 0; i < mac.length; i++) {
		mismatch |= mac.charCodeAt(i) ^ expected.charCodeAt(i);
	}
	if (mismatch !== 0) return false;
	const age = Date.now() - Number(ts);
	return age >= 0 && age <= NONCE_TTL_MS;
}

/**
 * Query recent login failures for an IP and return a PoW challenge if needed.
 * Returns null when no challenge is required or on error (fail-open).
 */
export async function computeChallenge(
	ipAddress: string,
	env: Env,
	config: ResolvedAdaptiveConfig = adaptiveDefaults,
	eventType = "login.failure",
): Promise<AdaptiveChallenge | null> {
	const since = new Date(
		Date.now() - config.windowMinutes * 60 * 1000,
	).toISOString();
	let failures = 0;
	try {
		await ensureSchema(env);
		const db = createDbClient(env);
		const result = await db.execute({
			sql: "SELECT COUNT(*) as count FROM security_event WHERE type IN (?, 'challenge.issued', 'challenge.failed') AND ip_address = ? AND created_at >= ?",
			args: [eventType, ipAddress, since],
		});
		failures = Number(result.rows[0]?.count ?? 0);
	} catch (err) {
		console.error("[obs] challenge query failed:", err);
		return null;
	}

	if (failures < config.failureThreshold) return null;

	const nonce = await buildSignedNonce(env.JWT_ACCESS_SECRET, ipAddress);

	return {
		type: "pow",
		difficulty:
			failures >= config.highThreshold
				? config.highDifficulty
				: config.lowDifficulty,
		nonce,
	};
}
