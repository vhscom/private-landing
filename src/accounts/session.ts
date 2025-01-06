import type { Context } from "hono";
import { getConnInfo } from "hono/cloudflare-workers";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import { createDbClient } from "../db";
import * as assert from "node:assert";

/**
 * Session information stored in database.
 * @property id - UUID v4 session identifier
 * @property userId - Associated user ID
 * @property userAgent - Browser user agent string
 * @property ipAddress - Client IP address
 * @property expiresAt - Session expiration timestamp
 * @property createdAt - Session creation timestamp
 */
interface SessionData {
	id: string;
	userId: number;
	userAgent: string;
	ipAddress: string;
	expiresAt: Date;
	createdAt: Date;
}

/**
 * Cookie configuration for secure session management.
 * Implements HTTP-only, secure, and SameSite=Strict for security.
 */
const COOKIE_CONFIG: CookieOptions = {
	httpOnly: true,
	secure: true,
	sameSite: "Strict",
	path: "/",
	maxAge: 60 * 60 * 24 * 7, // 7 days
	partitioned: true,
};

/**
 * Creates a new session for authenticated user.
 * Stores session data in database and sets signed cookie.
 *
 * @param userId - Authenticated user's ID
 * @param ctx - Hono context for request/response handling
 * @returns Session ID if successfully created
 */
export async function createSession(
	userId: number,
	ctx: Context,
): Promise<string> {
	const sessionId = crypto.randomUUID();
	const connInfo = getConnInfo(ctx);

	const { maxAge = 60 * 60 * 24 * 7 } = COOKIE_CONFIG;
	const sessionData: SessionData = {
		id: sessionId,
		userId,
		userAgent: ctx.req.header("user-agent") || "unknown",
		ipAddress: connInfo.remote?.address || "unknown",
		expiresAt: new Date(Date.now() + maxAge * 1000),
		createdAt: new Date(),
	};

	const dbClient = createDbClient(ctx.env);
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
		COOKIE_CONFIG,
	);

	return sessionId;
}

/**
 * Validates and retrieves current session.
 * Verifies session cookie signature and checks expiration.
 *
 * @param ctx - Hono context for request/response handling
 * @returns Session data if valid, null if no valid session
 */
export async function getSession(ctx: Context): Promise<SessionData | null> {
	const sessionId = await getSignedCookie(
		ctx,
		ctx.env.COOKIE_SIGNING,
		"session",
	);

	if (!sessionId) return null;

	const dbClient = createDbClient(ctx.env);
	const result = await dbClient.execute({
		sql: `SELECT * FROM session 
              WHERE id = ? AND expires_at > datetime('now')`,
		args: [sessionId],
	});

	if (result.rows.length === 0) return null;

	return result.rows[0] as unknown as SessionData;
}

/**
 * Ends user session by expiring database record and removing cookie.
 * @param ctx - Hono context for request/response handling
 */
export async function endSession(ctx: Context): Promise<void> {
	const sessionId = await getSignedCookie(
		ctx,
		ctx.env.COOKIE_SIGNING,
		"session",
	);

	if (sessionId) {
		const dbClient = createDbClient(ctx.env);
		await dbClient.execute({
			sql: `UPDATE session 
                  SET expires_at = datetime('now') 
                  WHERE id = ?`,
			args: [sessionId],
		});
	}

	deleteCookie(ctx, "session", COOKIE_CONFIG);
}
