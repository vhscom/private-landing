/**
 * @file session-service.ts
 * Handles user session management including creation, validation, and cleanup.
 * Implements sliding session expiration and session limiting per user.
 * @license LGPL-3.0-or-later
 */

import type { Client } from "@libsql/client/web";
import type { Context } from "hono";
import { getConnInfo } from "hono/cloudflare-workers";
import { deleteCookie } from "hono/cookie";
import { nanoid } from "nanoid";
import { createDbClient } from "../../infrastructure/db/client.ts";
import { defaultSessionConfig } from "../config/session-config.ts";
import type {
	SessionConfig,
	SessionState,
	TokenPayload,
} from "../types/auth.types.ts";
import { getAuthCookieSettings } from "../utils/cookie.ts";

/**
 * Removes expired sessions from the database to maintain database cleanliness.
 * Uses the current timestamp to identify and remove sessions that have passed their expiration date.
 *
 * @param dbClient - The database client instance
 * @returns Promise resolving to the number of sessions that were removed
 */
async function cleanupExpiredSessions(dbClient: Client): Promise<number> {
	const result = await dbClient.execute(
		`DELETE FROM session WHERE expires_at <= datetime('now')`,
	);
	return result.rowsAffected;
}

/**
 * Enforces a maximum limit on active sessions per user.
 * When the limit is exceeded, removes the oldest sessions while keeping the most recent ones.
 * Uses a window function to rank sessions by creation date and removes excess sessions.
 *
 * @param userId - The ID of the user to check sessions for
 * @param dbClient - The database client instance
 * @param maxSessions - Maximum number of concurrent sessions allowed per user
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
 * Updates a session's expiration time, implementing sliding session expiration.
 * Only updates sessions that haven't already expired.
 *
 * @param sessionId - The ID of the session to extend
 * @param dbClient - The database client instance
 * @param duration - New session duration in seconds
 * @returns Promise resolving to true if session was successfully extended
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
 * Creates a new session for an authenticated user.
 * Performs the following steps:
 * 1. Cleans up expired sessions
 * 2. Enforces session limits per user
 * 3. Generates a new session ID
 * 4. Records session details including user agent and IP
 *
 * @param userId - The ID of the user to create a session for
 * @param ctx - The Hono context object
 * @param config - Optional session configuration parameters
 * @returns Promise resolving to the newly created session ID
 */
export async function createSession(
	userId: number,
	ctx: Context,
	config: SessionConfig = defaultSessionConfig,
): Promise<string> {
	const dbClient = createDbClient(ctx.env);

	await cleanupExpiredSessions(dbClient);
	await enforceSessionLimit(userId, dbClient, config.maxSessions);

	const sessionId = nanoid();
	const connInfo = getConnInfo(ctx);

	const sessionData: SessionState = {
		id: sessionId,
		userId,
		userAgent: ctx.req.header("user-agent") || "unknown",
		ipAddress: connInfo.remote?.address || "unknown",
		expiresAt: new Date(
			Date.now() + config.sessionDuration * 1000,
		).toISOString(),
		createdAt: new Date().toISOString(),
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
			sessionData.expiresAt,
			sessionData.createdAt,
		],
	});

	return sessionId;
}

/**
 * Retrieves and validates the current session.
 * Implements sliding session expiration by extending valid sessions.
 * Returns null if the session is invalid or expired.
 *
 * @param ctx - The Hono context object
 * @param config - Optional session configuration parameters
 * @returns Promise resolving to session data or null if session is invalid
 */
export async function getSession(
	ctx: Context,
	config: SessionConfig = defaultSessionConfig,
): Promise<SessionState | null> {
	const payload = ctx.get("jwtPayload") as TokenPayload;
	const sessionId = payload?.sid;

	if (!sessionId) return null;

	const dbClient = createDbClient(ctx.env);

	const extended = await extendSession(
		sessionId,
		dbClient,
		config.sessionDuration,
	);

	if (!extended) return null;

	const result = await dbClient.execute({
		sql: "SELECT * FROM session WHERE id = ?",
		args: [sessionId],
	});

	if (result.rows.length === 0) return null;
	return result.rows[0] as unknown as SessionState;
}

/**
 * Terminates a user session and removes associated cookies.
 * Sets the session expiration to the current time and removes JWT cookies.
 *
 * @param ctx - Hono context containing request and environment
 */
export async function endSession(ctx: Context): Promise<void> {
	const payload = ctx.get("jwtPayload") as TokenPayload;
	const sessionId = payload.sid;

	if (!sessionId) return;

	const dbClient = createDbClient(ctx.env);
	await dbClient.execute({
		sql: `UPDATE session 
              SET expires_at = datetime('now') 
              WHERE id = ?`,
		args: [sessionId],
	});

	deleteCookie(ctx, "access_token", getAuthCookieSettings(ctx));
	deleteCookie(ctx, "refresh_token", getAuthCookieSettings(ctx));
}
