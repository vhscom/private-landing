/**
 * @file types.ts
 * Cache client interface and factory type for ephemeral state storage.
 *
 * @license Apache-2.0
 */

import type { Env } from "@private-landing/types";

/**
 * Cache client interface modeled after common Redis/Valkey commands.
 * Supports strings, integers, sets, and TTL-based expiration.
 */
export interface CacheClient {
	/** Get a string value by key. Returns null if the key does not exist. */
	get(key: string): Promise<string | null>;

	/** Set a string value with optional TTL in seconds. */
	set(key: string, value: string, ttl?: number): Promise<void>;

	/** Delete one or more keys. Returns the number of keys removed. */
	del(...keys: string[]): Promise<number>;

	/** Increment an integer value by 1. Returns the new value. */
	incr(key: string): Promise<number>;

	/** Set a TTL (in seconds) on an existing key. Returns true if the key exists. */
	expire(key: string, ttl: number): Promise<boolean>;

	/** Add one or more members to a set. Returns the number of members added. */
	sadd(key: string, ...members: string[]): Promise<number>;

	/** Remove one or more members from a set. Returns the number of members removed. */
	srem(key: string, ...members: string[]): Promise<number>;

	/** Get the number of members in a set. */
	scard(key: string): Promise<number>;

	/** Get all members of a set. */
	smembers(key: string): Promise<string[]>;
}

/**
 * Factory function that creates a CacheClient from environment bindings.
 */
export type CacheClientFactory = (env: Env) => CacheClient;
