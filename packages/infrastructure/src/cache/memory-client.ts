/**
 * @file memory-client.ts
 * In-memory CacheClient implementation backed by Map with TTL support.
 * Intended for unit tests only — not suitable for production use.
 *
 * @license Apache-2.0
 */

import type { CacheClient } from "./types";

interface Entry {
	value: string;
	expiresAt: number | null; // epoch ms, null = no expiry
}

/**
 * Creates an in-memory CacheClient with timestamp-based TTL expiration.
 *
 * @returns CacheClient backed by a Map
 */
export function createMemoryCacheClient(): CacheClient {
	const store = new Map<string, Entry>();
	const sets = new Map<string, Set<string>>();
	const setExpiry = new Map<string, number | null>();

	function isExpired(entry: { expiresAt: number | null }): boolean {
		return entry.expiresAt !== null && Date.now() >= entry.expiresAt;
	}

	function getEntry(key: string): Entry | null {
		const entry = store.get(key);
		if (!entry) return null;
		if (isExpired(entry)) {
			store.delete(key);
			return null;
		}
		return entry;
	}

	function getSet(key: string): Set<string> | null {
		const expiry = setExpiry.get(key);
		if (expiry !== undefined && expiry !== null && Date.now() >= expiry) {
			sets.delete(key);
			setExpiry.delete(key);
			return null;
		}
		return sets.get(key) ?? null;
	}

	return {
		async get(key) {
			const entry = getEntry(key);
			return entry?.value ?? null;
		},

		async set(key, value, ttl) {
			store.set(key, {
				value,
				expiresAt: ttl !== undefined ? Date.now() + ttl * 1000 : null,
			});
		},

		async del(...keys) {
			let count = 0;
			for (const key of keys) {
				if (store.delete(key)) count++;
				if (sets.delete(key)) {
					setExpiry.delete(key);
					// Count set keys if not already counted from store
					if (!store.has(key)) count++;
				}
			}
			return count;
		},

		async incr(key) {
			const entry = getEntry(key);
			const current = entry ? Number.parseInt(entry.value, 10) : 0;
			const next = (Number.isNaN(current) ? 0 : current) + 1;
			store.set(key, {
				value: String(next),
				expiresAt: entry?.expiresAt ?? null,
			});
			return next;
		},

		async expire(key, ttl) {
			const entry = store.get(key);
			if (entry && !isExpired(entry)) {
				entry.expiresAt = Date.now() + ttl * 1000;
				return true;
			}
			const s = getSet(key);
			if (s) {
				setExpiry.set(key, Date.now() + ttl * 1000);
				return true;
			}
			return false;
		},

		async sadd(key, ...members) {
			let s = getSet(key);
			if (!s) {
				s = new Set();
				sets.set(key, s);
				if (!setExpiry.has(key)) setExpiry.set(key, null);
			}
			let added = 0;
			for (const m of members) {
				if (!s.has(m)) {
					s.add(m);
					added++;
				}
			}
			return added;
		},

		async srem(key, ...members) {
			const s = getSet(key);
			if (!s) return 0;
			let removed = 0;
			for (const m of members) {
				if (s.delete(m)) removed++;
			}
			return removed;
		},

		async scard(key) {
			const s = getSet(key);
			return s?.size ?? 0;
		},

		async smembers(key) {
			const s = getSet(key);
			return s ? [...s] : [];
		},
	};
}
