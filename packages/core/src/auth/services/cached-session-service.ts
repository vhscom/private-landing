/**
 * @file cached-session-service.ts
 * Cache-backed session service implementation using CacheClient.
 * Moves ephemeral session state out of SQL into Valkey/Redis
 * while preserving the same SessionService interface.
 *
 * Key schema:
 * - `session:{sessionId}` → JSON SessionState, TTL = session duration
 * - `user_sessions:{userId}` → SET of session IDs, TTL = session duration
 *
 * @license Apache-2.0
 */

import {
	type CacheClientFactory,
	createValkeyClient,
} from "@private-landing/infrastructure";
import type {
	AuthContext,
	GetClientIpFn,
	SessionConfig,
	SessionState,
	TokenPayload,
} from "@private-landing/types";
import { deleteCookie } from "hono/cookie";
import { nanoid } from "nanoid";
import { defaultSessionConfig } from "../config";
import { getAuthCookieSettings } from "../utils";
import { defaultGetClientIp } from "../utils/get-client-ip";
import type { SessionService } from "./session-service";

/**
 * Configuration for the cached session service.
 */
export interface CachedSessionServiceConfig {
	/** Factory that creates a CacheClient from env bindings */
	createCacheClient?: CacheClientFactory;
	/** Optional function to extract client IP from request context */
	getClientIp?: GetClientIpFn;
}

/** Cache key for a single session. */
function sessionKey(id: string): string {
	return `session:${id}`;
}

/** Cache key for the per-user set of active session IDs. */
function userSessionsKey(userId: number): string {
	return `user_sessions:${userId}`;
}

/**
 * Creates a cache-backed session service.
 * Uses CacheClient (Valkey/Redis) for all session state — no SQL queries.
 *
 * @param config - Cache client factory and optional IP extraction function
 * @returns SessionService implementation backed by cache
 */
export function createCachedSessionService(
	config: CachedSessionServiceConfig = {},
): SessionService {
	const {
		createCacheClient: injectedFactory = createValkeyClient,
		getClientIp = defaultGetClientIp,
	} = config;

	/**
	 * Enforces the per-user session limit by evicting the oldest sessions
	 * that exceed `maxSessions`.
	 */
	async function enforceSessionLimit(
		cache: ReturnType<CacheClientFactory>,
		userId: number,
		maxSessions: number,
	): Promise<void> {
		const members = await cache.smembers(userSessionsKey(userId));
		if (members.length <= maxSessions) return;

		// Gather sessions with their creation timestamps
		const sessions: { id: string; createdAt: number }[] = [];
		for (const id of members) {
			const raw = await cache.get(sessionKey(id));
			if (!raw) {
				// Expired / missing — clean up the set
				await cache.srem(userSessionsKey(userId), id);
				continue;
			}
			const state = JSON.parse(raw) as SessionState;
			sessions.push({ id, createdAt: new Date(state.createdAt).getTime() });
		}

		if (sessions.length <= maxSessions) return;

		// Sort newest-first, evict the tail
		sessions.sort((a, b) => b.createdAt - a.createdAt);
		const toEvict = sessions.slice(maxSessions);
		for (const s of toEvict) {
			await cache.del(sessionKey(s.id));
			await cache.srem(userSessionsKey(userId), s.id);
		}
	}

	return {
		async createSession(
			userId: number,
			ctx: AuthContext,
			sessionConfig: SessionConfig = defaultSessionConfig,
		): Promise<string> {
			const cache = injectedFactory(ctx.env);
			const sessionId = nanoid();
			const ttl = sessionConfig.sessionDuration;

			const sessionData: SessionState = {
				id: sessionId,
				userId,
				userAgent: ctx.req.header("user-agent") || "unknown",
				ipAddress: getClientIp(ctx),
				expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
				createdAt: new Date().toISOString(),
			};

			await cache.set(sessionKey(sessionId), JSON.stringify(sessionData), ttl);
			await cache.sadd(userSessionsKey(userId), sessionId);
			await cache.expire(userSessionsKey(userId), ttl);
			await enforceSessionLimit(cache, userId, sessionConfig.maxSessions);

			return sessionId;
		},

		async getSession(
			ctx: AuthContext,
			sessionConfig: SessionConfig = defaultSessionConfig,
		): Promise<SessionState | null> {
			const payload = ctx.get("jwtPayload") as TokenPayload;
			const sessionId = payload?.sid;
			if (!sessionId) return null;

			const cache = injectedFactory(ctx.env);
			const raw = await cache.get(sessionKey(sessionId));
			if (!raw) return null;

			// Sliding expiration: reset TTL and update expiresAt to stay in sync
			const ttl = sessionConfig.sessionDuration;
			const state = JSON.parse(raw) as SessionState;
			state.expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
			await cache.set(sessionKey(sessionId), JSON.stringify(state), ttl);

			return state;
		},

		async endSession(ctx: AuthContext): Promise<void> {
			const payload = ctx.get("jwtPayload") as TokenPayload;
			const sessionId = payload?.sid;
			if (!sessionId) return;

			const cache = injectedFactory(ctx.env);
			const raw = await cache.get(sessionKey(sessionId));
			if (raw) {
				const state = JSON.parse(raw) as SessionState;
				await cache.del(sessionKey(sessionId));
				await cache.srem(userSessionsKey(state.userId), sessionId);
			}

			deleteCookie(ctx, "access_token", getAuthCookieSettings());
			deleteCookie(ctx, "refresh_token", getAuthCookieSettings());
		},

		async endAllSessionsForUser(
			userId: number,
			ctx: AuthContext,
		): Promise<void> {
			const cache = injectedFactory(ctx.env);
			const members = await cache.smembers(userSessionsKey(userId));

			if (members.length > 0) {
				for (const id of members) {
					await cache.del(sessionKey(id));
				}
				await cache.del(userSessionsKey(userId));
			}

			deleteCookie(ctx, "access_token", getAuthCookieSettings());
			deleteCookie(ctx, "refresh_token", getAuthCookieSettings());
		},
	};
}
