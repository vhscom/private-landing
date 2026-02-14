/**
 * @file valkey-client.ts
 * Valkey/Redis REST protocol client using the standard fetch API.
 * Zero dependencies — works on Cloudflare Workers, Bun, Deno, and Node.
 *
 * Speaks the Redis REST protocol: POST JSON command arrays over HTTP.
 * Compatible with Upstash, webdis, and any endpoint exposing this interface.
 *
 * @license Apache-2.0
 */

import type { Env } from "@private-landing/types";
import type { CacheClient } from "./types";

/**
 * Sends a Redis command via the REST protocol.
 *
 * @param url - Base URL of the Redis REST endpoint
 * @param token - Optional bearer token for authentication
 * @param args - Redis command as an array of strings/numbers
 * @returns Parsed `result` field from the JSON response
 */
async function command(
	url: string,
	token: string | undefined,
	args: (string | number)[],
): Promise<unknown> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}

	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(args),
	});

	if (!response.ok) {
		const body = await response.text();
		throw new Error(`Cache command failed (${response.status}): ${body}`);
	}

	const json = (await response.json()) as { result: unknown };
	return json.result;
}

/**
 * Creates a CacheClient backed by a Valkey/Redis REST endpoint.
 *
 * @param env - Environment bindings containing CACHE_URL and optional CACHE_TOKEN
 * @returns CacheClient implementation
 */
export function createValkeyClient(env: Env): CacheClient {
	const url = env.CACHE_URL;
	if (!url) {
		throw new Error("CACHE_URL environment variable is required");
	}
	const token = env.CACHE_TOKEN;

	return {
		async get(key) {
			const result = await command(url, token, ["GET", key]);
			return (result as string) ?? null;
		},

		async set(key, value, ttl) {
			const args: (string | number)[] = ["SET", key, value];
			if (ttl !== undefined) {
				args.push("EX", ttl);
			}
			await command(url, token, args);
		},

		async del(...keys) {
			if (keys.length === 0) return 0;
			const result = await command(url, token, ["DEL", ...keys]);
			return result as number;
		},

		async incr(key) {
			const result = await command(url, token, ["INCR", key]);
			return result as number;
		},

		async expire(key, ttl) {
			const result = await command(url, token, ["EXPIRE", key, ttl]);
			return result === 1;
		},

		async sadd(key, ...members) {
			if (members.length === 0) return 0;
			const result = await command(url, token, ["SADD", key, ...members]);
			return result as number;
		},

		async srem(key, ...members) {
			if (members.length === 0) return 0;
			const result = await command(url, token, ["SREM", key, ...members]);
			return result as number;
		},

		async scard(key) {
			const result = await command(url, token, ["SCARD", key]);
			return result as number;
		},

		async smembers(key) {
			const result = await command(url, token, ["SMEMBERS", key]);
			return (result as string[]) ?? [];
		},
	};
}
