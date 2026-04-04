/**
 * @file mirrored-session-service.ts
 * Decorator that adds best-effort SQL writes to any SessionService (ADR-007).
 * Cache remains authoritative for auth; SQL mirrors state for ops visibility.
 *
 * @license Apache-2.0
 */

import {
	type DbClientFactory,
	createDbClient as defaultCreateDbClient,
} from "@private-landing/infrastructure";
import type {
	AuthContext,
	GetClientIpFn,
	SessionConfig,
	SessionTableConfig,
} from "@private-landing/types";
import { defaultSessionConfig } from "../config";
import type { SessionService } from "./session-service";

/** Default table/column names — matches session-service.ts defaults */
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
 * Configuration for the mirrored session decorator.
 */
export interface MirroredSessionServiceConfig extends SessionTableConfig {
	/** The inner session service to decorate (typically cache-backed) */
	inner: SessionService;
	/** Factory that creates a DB client for SQL writes */
	createDbClient?: DbClientFactory;
	/** Extracts the client IP from a request context */
	getClientIp?: GetClientIpFn;
}

/**
 * Wraps a SessionService with best-effort SQL mirrors.
 * Delegates all operations to `inner`, then mirrors mutations to SQL.
 * SQL failures are caught and logged — they never block the auth path.
 *
 * @param config - Inner service and optional DB client factory
 * @returns SessionService with SQL mirroring behavior
 */
export function createMirroredSessionService(
	config: MirroredSessionServiceConfig,
): SessionService {
	const {
		inner,
		createDbClient = defaultCreateDbClient,
		getClientIp,
		...tableConfig
	} = config;
	const rc = { ...DEFAULT_TABLE_CONFIG, ...tableConfig };

	return {
		async createSession(
			userId: number,
			ctx: AuthContext,
			sessionConfig: SessionConfig = defaultSessionConfig,
		): Promise<string> {
			const sessionId = await inner.createSession(userId, ctx, sessionConfig);

			const duration =
				sessionConfig.sessionDuration ?? defaultSessionConfig.sessionDuration;

			let ip = "unknown";
			if (getClientIp) {
				try {
					ip = getClientIp(ctx);
				} catch {
					// getConnInfo may not be available in all contexts
				}
			}

			try {
				const db = createDbClient(ctx.env);

				await db.execute({
					sql: `INSERT INTO ${rc.tableName} (${rc.idColumn}, ${rc.userIdColumn}, ${rc.userAgentColumn}, ${rc.ipAddressColumn}, ${rc.expiresAtColumn}, ${rc.createdAtColumn})
						  VALUES (?, ?, ?, ?, datetime('now', '+' || ? || ' seconds'), datetime('now'))`,
					args: [
						sessionId,
						userId,
						ctx.req.header("user-agent") || "unknown",
						ip,
						duration,
					],
				});

				// Mirror the session limit enforcement (expire oldest beyond maxSessions)
				await db.execute({
					sql: `WITH ranked AS (
						    SELECT ${rc.idColumn}, ROW_NUMBER() OVER (
						      PARTITION BY ${rc.userIdColumn} ORDER BY ${rc.createdAtColumn} DESC
						    ) AS rn FROM ${rc.tableName}
						    WHERE ${rc.userIdColumn} = ? AND ${rc.expiresAtColumn} > datetime('now')
						  )
						  UPDATE ${rc.tableName} SET ${rc.expiresAtColumn} = datetime('now')
						  WHERE ${rc.idColumn} IN (SELECT ${rc.idColumn} FROM ranked WHERE rn > ?)`,
					args: [userId, sessionConfig.maxSessions],
				});
			} catch (error) {
				console.error("[mirrored-session] create failed:", error);
			}

			return sessionId;
		},

		getSession: inner.getSession.bind(inner),

		async endSession(ctx: AuthContext): Promise<void> {
			await inner.endSession(ctx);

			try {
				const payload = ctx.get("jwtPayload") as { sid?: string } | undefined;
				if (payload?.sid) {
					const db = createDbClient(ctx.env);
					await db.execute({
						sql: `UPDATE ${rc.tableName} SET ${rc.expiresAtColumn} = datetime('now') WHERE ${rc.idColumn} = ?`,
						args: [payload.sid],
					});
				}
			} catch (error) {
				console.error("[mirrored-session] end failed:", error);
			}
		},

		async endAllSessionsForUser(
			userId: number,
			ctx: AuthContext,
		): Promise<void> {
			await inner.endAllSessionsForUser(userId, ctx);

			try {
				const db = createDbClient(ctx.env);
				await db.execute({
					sql: `UPDATE ${rc.tableName} SET ${rc.expiresAtColumn} = datetime('now') WHERE ${rc.userIdColumn} = ? AND ${rc.expiresAtColumn} > datetime('now')`,
					args: [userId],
				});
			} catch (error) {
				console.error("[mirrored-session] endAll failed:", error);
			}
		},
	};
}
