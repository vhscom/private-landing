import type { KVNamespace } from "@cloudflare/workers-types";
import type { Context } from "hono";
import { getConnInfo } from "hono/cloudflare-workers";
import { createMiddleware } from "hono/factory";
import type { RateLimitRule } from "../config/rate-limit-config";
import type { RateLimitContext, Variables } from "../types/context";

interface ClientInfo {
	address: string;
	type: "IPv4" | "IPv6" | "unknown";
	asn?: number;
	country?: string;
	region?: string;
	colo?: string;
}

/**
 * Rate limiting middleware implementing Phase 1 from ADR-002.
 * Uses Cloudflare KV for distributed request tracking.
 *
 * Protects against:
 * - Brute force attacks on login endpoints
 * - Token refresh abuse
 * - Password reset flooding
 * - Distributed attacks using multiple IPs
 *
 * Features:
 * - Geographic rate limiting using CF data
 * - ASN-level monitoring for botnet detection
 * - Privacy-preserving IP tracking
 * - Auto-expiring counters via KV TTL
 * - Standardized 429 responses
 *
 * Key format: prefix:hash(ip):type:asn:country
 * Example: rl:login:a1b2c3d4:IPv4:12345:US
 *
 * @param rule - Rate limit configuration for the endpoint
 * @see {@link docs/adr/002-auth-enhancements.md ADR-002} for rate limiting design
 */
export const createRateLimit = (rule: RateLimitRule) => {
	return createMiddleware<{
		Bindings: { AUTH_KV: KVNamespace };
		Variables: Variables;
	}>(async (c, next) => {
		const ctx = c as unknown as RateLimitContext;
		const clientInfo = getClientInfo(ctx);
		const key = await createRateLimitKey(rule.keyPrefix, clientInfo);

		const attemptCount = await getCurrentAttempts(ctx, key);
		if (attemptCount >= rule.maxAttempts) {
			return createRateLimitResponse(ctx, rule.windowSeconds);
		}

		await incrementAttempts(ctx, key, rule.windowSeconds);
		return next();
	});
};

/**
 * Gets client connection and location information for rate limiting.
 * Uses Cloudflare-provided data for enhanced request origin identification.
 *
 * @param ctx - Hono context with Cloudflare bindings
 * @returns Client connection information including IP, ASN, and geo data
 */
function getClientInfo(ctx: RateLimitContext): ClientInfo {
	// Coerce type to satisfy Hono
	const connInfo = getConnInfo(ctx as unknown as Context);

	return {
		address: normalizeIP(connInfo.remote.address || "unknown"),
		type: "IPv4", // Cloudflare normalizes all IPs
		asn: ctx.cf?.asn as number | undefined,
		country: ctx.cf?.country as string | undefined,
		region: ctx.cf?.region as string | undefined,
		colo: ctx.cf?.colo as string | undefined,
	};
}

/**
 * Creates a rate limit key incorporating client information.
 * Format: prefix:hash(ip):type:asn:country
 * Example: rl:login:a1b2c3d4:IPv4:12345:US
 *
 * @param prefix - Rate limit key prefix for the endpoint
 * @param info - Client connection information
 * @returns Composite rate limit key
 */
async function createRateLimitKey(
	prefix: string,
	info: ClientInfo,
): Promise<string> {
	const addressHash = await hashIP(info.address);

	const parts = [
		prefix,
		addressHash,
		info.type,
		info.asn || "unknown",
		info.country || "unknown",
	];

	return parts.join(":");
}

/**
 * Gets current attempt count for the given rate limit key.
 * Auto-expires based on KV TTL settings.
 *
 * @param ctx - Hono context with Cloudflare bindings
 * @param key - Rate limit key to check
 * @returns Current number of attempts in the window
 */
async function getCurrentAttempts(
	ctx: RateLimitContext,
	key: string,
): Promise<number> {
	const value = await ctx.env.AUTH_KV.get(key);
	return value ? Number.parseInt(value) : 0;
}

/**
 * Increments attempt counter with expiry.
 * Uses KV TTL for automatic window expiration.
 *
 * @param ctx - Hono context with Cloudflare bindings
 * @param key - Rate limit key to increment
 * @param windowSeconds - Time window for rate limiting
 */
async function incrementAttempts(
	ctx: RateLimitContext,
	key: string,
	windowSeconds: number,
): Promise<void> {
	const current = await getCurrentAttempts(ctx, key);
	await ctx.env.AUTH_KV.put(key, (current + 1).toString(), {
		expirationTtl: windowSeconds,
	});
}

/**
 * Creates standardized rate limit exceeded response.
 * Follows RFC 6585 for HTTP 429 Too Many Requests.
 *
 * @param ctx - Hono context with Cloudflare bindings
 * @param retryAfter - Seconds until next attempt allowed
 * @returns Rate limit response with retry header
 */
function createRateLimitResponse(ctx: RateLimitContext, retryAfter: number) {
	ctx.res.headers.set("Retry-After", retryAfter.toString());
	return ctx.json(
		{
			error: "Too many attempts",
			retryAfter,
		},
		429,
	);
}

/**
 * Creates a deterministic hash of an IP address.
 * Uses SHA-256 truncated to 32 chars for storage efficiency.
 *
 * @param ip - IP address to hash
 * @returns Truncated hash of IP
 */
async function hashIP(ip: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(ip);
	const hash = await crypto.subtle.digest("SHA-256", data);

	return new Uint8Array(hash)
		.reduce((str, byte) => str + byte.toString(16).padStart(2, "0"), "")
		.slice(0, 32);
}

/**
 * Normalizes IP addresses, handling IPv4-mapped IPv6 addresses.
 * Ensures consistent IP handling since Cloudflare may send IPv4 as mapped IPv6.
 *
 * @param ip - IP address to normalize
 * @returns Normalized IP address
 */
function normalizeIP(ip: string): string {
	const ipv4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (ipv4Mapped) {
		return ipv4Mapped[1];
	}
	return ip;
}
