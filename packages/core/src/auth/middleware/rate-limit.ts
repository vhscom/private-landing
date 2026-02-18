/**
 * @file rate-limit.ts
 * Rate limiting middleware using fixed-window counters backed by CacheClient.
 * Provides a factory that creates independently configurable rate limiters.
 *
 * @license Apache-2.0
 * @see ADR-006 for rate limiting design
 */

import type {
	CacheClient,
	CacheClientFactory,
} from "@private-landing/infrastructure";
import type { Env, GetClientIpFn, Variables } from "@private-landing/types";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { MiddlewareHandler } from "hono/types";
import { defaultGetClientIp } from "../utils/get-client-ip";

/**
 * Dependencies for the rate limiter factory.
 */
export interface RateLimitDeps {
	createCacheClient: CacheClientFactory;
	getClientIp?: GetClientIpFn;
}

/**
 * Configuration for an individual rate limiter instance.
 */
export interface RateLimitConfig {
	/** Window size in seconds. */
	windowSeconds: number;
	/** Maximum requests allowed per window. */
	max: number;
	/** Cache key prefix (e.g. "rl:login"). */
	prefix: string;
	/** Optional key extractor. Defaults to IP-based keying via `getClientIp`. */
	key?: (ctx: Context<{ Bindings: Env; Variables: Variables }>) => string;
}

/**
 * Creates a rate limiter factory from cache dependencies.
 * Returns a function that produces Hono middleware for each config.
 *
 * Uses a fixed-window counter algorithm: INCR + EXPIRE on first hit.
 *
 * When `deps` is `null`, the returned factory produces pass-through no-op
 * middleware, allowing rate limiting to degrade gracefully when no cache
 * factory is provided. This matches the `createAuthSystem` pattern where
 * cache features require an explicit code change to activate (ADR-003).
 *
 * @param deps - Cache client factory and optional IP extraction function, or null
 * @returns Function that creates rate-limit middleware from a config
 *
 * @example
 * ```typescript
 * const rateLimit = createRateLimiter({ createCacheClient: createValkeyClient });
 * app.post("/auth/login", rateLimit({ windowSeconds: 300, max: 5, prefix: "rl:login" }), handler);
 * ```
 */
export function createRateLimiter(
	deps: RateLimitDeps | null,
): (config: RateLimitConfig) => MiddlewareHandler {
	if (!deps) {
		return () =>
			createMiddleware<{ Bindings: Env; Variables: Variables }>(
				async (_ctx, next) => next(),
			);
	}

	const { createCacheClient, getClientIp = defaultGetClientIp } = deps;

	return (config: RateLimitConfig) => {
		const { windowSeconds, max, prefix, key: keyExtractor } = config;

		return createMiddleware<{
			Bindings: Env;
			Variables: Variables;
		}>(async (ctx, next) => {
			try {
				const cache: CacheClient = createCacheClient(ctx.env);
				const identifier = keyExtractor ? keyExtractor(ctx) : getClientIp(ctx);
				const key = `${prefix}:${identifier}`;

				const count = await cache.incr(key);

				if (count === 1) {
					await cache.expire(key, windowSeconds);
				}

				if (count > max) {
					ctx.res = ctx.json(
						{ error: "Too many requests", code: "RATE_LIMIT" },
						429,
						{ "Retry-After": String(windowSeconds) },
					);
					return;
				}
			} catch (error) {
				// Fail open: cache outage should not block requests
				console.error("Rate limiter error:", error);
			}

			await next();
		});
	};
}
