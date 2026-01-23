/**
 * @file session-service.ts
 * Handles user session management including creation, validation, and cleanup.
 * Implements sliding session expiration and session limiting per user.
 *
 * Features:
 * - Configurable table and column names
 * - Sliding session expiration
 * - Session cleanup and limits
 * - IP and user agent tracking
 *
 * @license Apache-2.0
 */

import type { Client } from "@libsql/client/web";
import {
	type DbClientFactory,
	createDbClient as defaultCreateDbClient,
} from "@private-landing/infrastructure";
import type {
	AuthContext,
	SessionConfig,
	SessionState,
	SessionTable,
	SessionTableConfig,
	TokenPayload,
} from "@private-landing/types";
import { getConnInfo } from "hono/cloudflare-workers";
import { deleteCookie } from "hono/cookie";
import { nanoid } from "nanoid";
import { defaultSessionConfig } from "../config";
import { getAuthCookieSettings } from "../utils";

/**
 * Interface defining the session service API.
 * Provides methods for session lifecycle management.
 */
export interface SessionService {
	/**
	 * Creates new authenticated session.
	 * Manages session lifecycle by cleaning expired sessions and enforcing limits.
	 *
	 * @param userId - User to create session for
	 * @param ctx - Auth context with environment and request data
	 * @param sessionConfig - Optional session behavior configuration
	 * @returns Newly created session ID
	 */
	createSession(
		userId: number,
		ctx: AuthContext,
		sessionConfig?: SessionConfig,
	): Promise<string>;

	/**
	 * Retrieves and validates current session.
	 * Implements sliding expiration by extending valid sessions.
	 *
	 * @param ctx - Auth context containing session information
	 * @param sessionConfig - Optional session behavior configuration
	 * @returns Session data if valid, null otherwise
	 */
	getSession(
		ctx: AuthContext,
		sessionConfig?: SessionConfig,
	): Promise<SessionState | null>;

	/**
	 * Ends user session and removes associated tokens.
	 * Expires session immediately and clears auth cookies.
	 *
	 * @param ctx - Auth context containing session to end
	 */
	endSession(ctx: AuthContext): Promise<void>;
}

/**
 * Configuration options for session service.
 */
export interface SessionServiceConfig extends SessionTableConfig {
	/** Optional database client factory for dependency injection */
	createDbClient?: DbClientFactory;
}

/**
 * Default table and column names for session management.
 * Can be overridden through SessionTableConfig.
 */
const DEFAULT_TABLE_CONFIG: Required<SessionTableConfig> = {
	tableName: "session",
	idColumn: "id",
	userIdColumn: "user_id",
	userAgentColumn: "user_agent",
	ipAddressColumn: "ip_address",
	expiresAtColumn: "expires_at",
	createdAtColumn: "created_at",
};

/**
 * Creates a configured session management service.
 * Provides methods for creating, retrieving, and ending user sessions
 * with support for custom table schemas.
 *
 * @param config - Configuration for session table schema and dependencies
 * @returns Session management service with CRUD operations
 */
export function createSessionService(
	config: SessionServiceConfig = {},
): SessionService {
	const { createDbClient: injectedCreateDbClient, ...tableConfig } = config;
	const resolvedConfig = { ...DEFAULT_TABLE_CONFIG, ...tableConfig };
	const createDbClient = injectedCreateDbClient ?? defaultCreateDbClient;

	/**
	 * Removes expired sessions from the database.
	 * Uses database timestamp comparison for accurate cleanup.
	 *
	 * @param dbClient - Database client instance
	 * @returns Number of sessions removed
	 */
	async function cleanupExpiredSessions(dbClient: Client): Promise<number> {
		const result = await dbClient.execute(
			`DELETE FROM ${resolvedConfig.tableName}
			 WHERE ${resolvedConfig.expiresAtColumn} <= datetime('now')`,
		);
		return result.rowsAffected;
	}

	/**
	 * Enforces maximum concurrent sessions per user.
	 * Removes oldest sessions when limit is exceeded, keeping most recent ones.
	 *
	 * @param userId - User to enforce limits for
	 * @param dbClient - Database client instance
	 * @param maxSessions - Maximum allowed concurrent sessions
	 */
	async function enforceSessionLimit(
		userId: number,
		dbClient: Client,
		maxSessions: number,
	): Promise<void> {
		await dbClient.execute({
			sql: `WITH ranked_sessions AS (
				SELECT ${resolvedConfig.idColumn},
					   ROW_NUMBER() OVER (
                      PARTITION BY ${resolvedConfig.userIdColumn}
                      ORDER BY ${resolvedConfig.createdAtColumn} DESC
                  ) as rn
				FROM ${resolvedConfig.tableName}
				WHERE ${resolvedConfig.userIdColumn} = ?
				  AND ${resolvedConfig.expiresAtColumn} > datetime('now')
			)
			DELETE FROM ${resolvedConfig.tableName}
			WHERE ${resolvedConfig.idColumn} IN (
				SELECT ${resolvedConfig.idColumn} FROM ranked_sessions
				WHERE rn > ?
			)`,
			args: [userId, maxSessions],
		});
	}

	/**
	 * Extends session lifetime implementing sliding expiration.
	 * Only extends sessions that haven't already expired.
	 *
	 * @param sessionId - Session to extend
	 * @param dbClient - Database client instance
	 * @param duration - New duration in seconds
	 * @returns Whether session was successfully extended
	 */
	async function extendSession(
		sessionId: string,
		dbClient: Client,
		duration: number,
	): Promise<boolean> {
		const result = await dbClient.execute({
			sql: `UPDATE ${resolvedConfig.tableName}
				  SET ${resolvedConfig.expiresAtColumn} = datetime('now', '+' || ? || ' seconds')
				  WHERE ${resolvedConfig.idColumn} = ?
					AND ${resolvedConfig.expiresAtColumn} > datetime('now')`,
			args: [duration, sessionId],
		});
		return result.rowsAffected > 0;
	}

	return {
		async createSession(
			userId: number,
			ctx: AuthContext,
			sessionConfig: SessionConfig = defaultSessionConfig,
		): Promise<string> {
			const dbClient = createDbClient(ctx.env);

			await cleanupExpiredSessions(dbClient);
			await enforceSessionLimit(userId, dbClient, sessionConfig.maxSessions);

			const sessionId = nanoid();
			const connInfo = getConnInfo(ctx);

			const sessionData: SessionState = {
				id: sessionId,
				userId,
				userAgent: ctx.req.header("user-agent") || "unknown",
				ipAddress: connInfo.remote?.address || "unknown",
				expiresAt: new Date(
					Date.now() + sessionConfig.sessionDuration * 1000,
				).toISOString(),
				createdAt: new Date().toISOString(),
			};

			await dbClient.execute({
				sql: `INSERT INTO ${resolvedConfig.tableName} (
					${resolvedConfig.idColumn},
					${resolvedConfig.userIdColumn},
					${resolvedConfig.userAgentColumn},
					${resolvedConfig.ipAddressColumn},
					${resolvedConfig.expiresAtColumn},
					${resolvedConfig.createdAtColumn}
				) VALUES (?, ?, ?, ?, ?, ?)`,
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
		},

		async getSession(
			ctx: AuthContext,
			sessionConfig: SessionConfig = defaultSessionConfig,
		): Promise<SessionState | null> {
			const payload = ctx.get("jwtPayload") as TokenPayload;
			const sessionId = payload?.sid;

			if (!sessionId) return null;

			const dbClient = createDbClient(ctx.env);

			const extended = await extendSession(
				sessionId,
				dbClient,
				sessionConfig.sessionDuration,
			);

			if (!extended) return null;

			const result = await dbClient.execute({
				sql: `SELECT * FROM ${resolvedConfig.tableName} WHERE ${resolvedConfig.idColumn} = ?`,
				args: [sessionId],
			});

			if (result.rows.length === 0) return null;
			return result.rows[0] as Partial<SessionTable> as SessionState;
		},

		async endSession(ctx: AuthContext): Promise<void> {
			const payload = ctx.get("jwtPayload") as TokenPayload;
			const sessionId = payload.sid;

			if (!sessionId) return;

			const dbClient = createDbClient(ctx.env);
			await dbClient.execute({
				sql: `UPDATE ${resolvedConfig.tableName}
					  SET ${resolvedConfig.expiresAtColumn} = datetime('now')
					  WHERE ${resolvedConfig.idColumn} = ?`,
				args: [sessionId],
			});

			deleteCookie(ctx, "access_token", getAuthCookieSettings(ctx));
			deleteCookie(ctx, "refresh_token", getAuthCookieSettings(ctx));
		},
	};
}
