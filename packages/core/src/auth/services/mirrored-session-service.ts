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
} from "@private-landing/types";
import { defaultSessionConfig } from "../config";
import type { SessionService } from "./session-service";

/**
 * Configuration for the mirrored session decorator.
 */
export interface MirroredSessionServiceConfig {
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
	const { inner, createDbClient = defaultCreateDbClient, getClientIp } = config;

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
					sql: `INSERT INTO session (id, user_id, user_agent, ip_address, expires_at, created_at)
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
						    SELECT id, ROW_NUMBER() OVER (
						      PARTITION BY user_id ORDER BY created_at DESC
						    ) AS rn FROM session
						    WHERE user_id = ? AND expires_at > datetime('now')
						  )
						  UPDATE session SET expires_at = datetime('now')
						  WHERE id IN (SELECT id FROM ranked WHERE rn > ?)`,
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
						sql: "UPDATE session SET expires_at = datetime('now') WHERE id = ?",
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
					sql: "UPDATE session SET expires_at = datetime('now') WHERE user_id = ? AND expires_at > datetime('now')",
					args: [userId],
				});
			} catch (error) {
				console.error("[mirrored-session] endAll failed:", error);
			}
		},
	};
}
