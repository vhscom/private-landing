import type { Client } from "@libsql/client/web";
import type { Context } from "hono";
import { getConnInfo } from "hono/cloudflare-workers";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { createDbClient } from "../db";
import {
	type SessionConfig,
	type SessionData,
	defaultSessionConfig,
} from "./session-config";

/**
 * Removes expired sessions from the database.
 * @param dbClient - Database client
 * @returns Number of sessions cleaned up
 */
async function cleanupExpiredSessions(dbClient: Client): Promise<number> {
	const result = await dbClient.execute(
		`DELETE FROM session WHERE expires_at <= datetime('now')`,
	);
	return result.rowsAffected;
}

/**
 * Limits the number of active sessions per user.
 * @param userId - User ID to check
 * @param dbClient - Database client
 * @param maxSessions - Maximum allowed sessions per user
 */
async function enforceSessionLimit(
	userId: number,
	dbClient: Client,
	maxSessions: number,
): Promise<void> {
	await dbClient.execute({
		sql: `WITH ranked_sessions AS (
                SELECT id,
                       ROW_NUMBER() OVER (
                           PARTITION BY user_id 
                           ORDER BY created_at DESC
                       ) as rn
                FROM session
                WHERE user_id = ? AND expires_at > datetime('now')
              )
              DELETE FROM session 
              WHERE id IN (
                SELECT id FROM ranked_sessions 
                WHERE rn > ?
              )`,
		args: [userId, maxSessions],
	});
}

/**
 * Updates session expiry time (sliding expiration).
 * @param sessionId - Session to update
 * @param dbClient - Database client
 * @param duration - Session duration in seconds
 * @returns true if session was updated
 */
async function extendSession(
	sessionId: string,
	dbClient: Client,
	duration: number,
): Promise<boolean> {
	const result = await dbClient.execute({
		sql: `UPDATE session
			  SET expires_at = datetime('now', '+' || ? || ' seconds')
			  WHERE id = ? AND expires_at > datetime('now')`,
		args: [duration, sessionId],
	});
	return result.rowsAffected > 0;
}

/**
 * Creates a new session for authenticated user.
 * Stores session data and sets secure cookie.
 */
export async function createSession(
	userId: number,
	ctx: Context,
	config: SessionConfig = defaultSessionConfig,
): Promise<string> {
	const dbClient = createDbClient(ctx.env);

	await cleanupExpiredSessions(dbClient);
	await enforceSessionLimit(userId, dbClient, config.maxSessions);

	const sessionId = crypto.randomUUID();
	const connInfo = getConnInfo(ctx);

	const sessionData: SessionData = {
		id: sessionId,
		userId,
		userAgent: ctx.req.header("user-agent") || "unknown",
		ipAddress: connInfo.remote?.address || "unknown",
		expiresAt: new Date(Date.now() + config.sessionDuration * 1000),
		createdAt: new Date(),
	};

	await dbClient.execute({
		sql: `INSERT INTO session 
              (id, user_id, user_agent, ip_address, expires_at, created_at) 
              VALUES (?, ?, ?, ?, ?, ?)`,
		args: [
			sessionData.id,
			sessionData.userId,
			sessionData.userAgent,
			sessionData.ipAddress,
			sessionData.expiresAt.toISOString(),
			sessionData.createdAt.toISOString(),
		],
	});

	await setSignedCookie(
		ctx,
		"session",
		sessionId,
		ctx.env.COOKIE_SIGNING,
		config.cookie,
	);
	return sessionId;
}

/**
 * Gets and validates current session.
 * Implements sliding expiration.
 */
export async function getSession(
	ctx: Context,
	config: SessionConfig = defaultSessionConfig,
): Promise<SessionData | null> {
	const sessionId = await getSignedCookie(
		ctx,
		ctx.env.COOKIE_SIGNING,
		"session",
	);
	if (!sessionId) return null;

	const dbClient = createDbClient(ctx.env);

	const extended = await extendSession(
		sessionId,
		dbClient,
		config.sessionDuration,
	);
	if (!extended) {
		deleteCookie(ctx, "session", config.cookie);
		return null;
	}

	const result = await dbClient.execute({
		sql: "SELECT * FROM session WHERE id = ?",
		args: [sessionId],
	});

	if (result.rows.length === 0) return null;
	return result.rows[0] as unknown as SessionData;
}

/**
 * Ends user session and removes cookie.
 */
export async function endSession(
	ctx: Context,
	config: SessionConfig = defaultSessionConfig,
): Promise<void> {
	const sessionId = await getSignedCookie(
		ctx,
		ctx.env.COOKIE_SIGNING,
		"session",
	);
	if (!sessionId) return;

	const dbClient = createDbClient(ctx.env);
	await dbClient.execute({
		sql: `UPDATE session 
              SET expires_at = datetime('now') 
              WHERE id = ?`,
		args: [sessionId],
	});

	deleteCookie(ctx, "session", config.cookie);
}
