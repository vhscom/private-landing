/**
 * @file memory-client.test.ts
 * Unit tests for the in-memory CacheClient implementation.
 *
 * @license Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryCacheClient } from "../src/cache/memory-client";
import type { CacheClient } from "../src/cache/types";

describe("MemoryCacheClient", () => {
	let cache: CacheClient;

	beforeEach(() => {
		cache = createMemoryCacheClient();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("get / set", () => {
		it("should return null for missing keys", async () => {
			expect(await cache.get("missing")).toBeNull();
		});

		it("should store and retrieve a value", async () => {
			await cache.set("key", "value");
			expect(await cache.get("key")).toBe("value");
		});

		it("should overwrite existing values", async () => {
			await cache.set("key", "first");
			await cache.set("key", "second");
			expect(await cache.get("key")).toBe("second");
		});
	});

	describe("TTL expiration", () => {
		it("should expire keys after TTL", async () => {
			await cache.set("key", "value", 10);
			expect(await cache.get("key")).toBe("value");

			vi.advanceTimersByTime(10_000);
			expect(await cache.get("key")).toBeNull();
		});

		it("should not expire keys without TTL", async () => {
			await cache.set("key", "value");
			vi.advanceTimersByTime(999_999_000);
			expect(await cache.get("key")).toBe("value");
		});
	});

	describe("del", () => {
		it("should delete existing keys", async () => {
			await cache.set("a", "1");
			await cache.set("b", "2");
			const count = await cache.del("a", "b");
			expect(count).toBe(2);
			expect(await cache.get("a")).toBeNull();
			expect(await cache.get("b")).toBeNull();
		});

		it("should return 0 for non-existent keys", async () => {
			expect(await cache.del("nope")).toBe(0);
		});
	});

	describe("incr", () => {
		it("should start at 1 for missing keys", async () => {
			expect(await cache.incr("counter")).toBe(1);
		});

		it("should increment existing integer values", async () => {
			await cache.set("counter", "5");
			expect(await cache.incr("counter")).toBe(6);
			expect(await cache.incr("counter")).toBe(7);
		});

		it("should preserve TTL on existing keys", async () => {
			await cache.set("counter", "1", 60);
			await cache.incr("counter");
			vi.advanceTimersByTime(60_000);
			expect(await cache.get("counter")).toBeNull();
		});
	});

	describe("expire", () => {
		it("should set TTL on existing string keys", async () => {
			await cache.set("key", "value");
			const result = await cache.expire("key", 5);
			expect(result).toBe(true);

			vi.advanceTimersByTime(5_000);
			expect(await cache.get("key")).toBeNull();
		});

		it("should return false for non-existent keys", async () => {
			expect(await cache.expire("missing", 10)).toBe(false);
		});

		it("should set TTL on existing set keys", async () => {
			await cache.sadd("myset", "a");
			expect(await cache.expire("myset", 5)).toBe(true);

			vi.advanceTimersByTime(5_000);
			expect(await cache.smembers("myset")).toEqual([]);
		});
	});

	describe("SET operations", () => {
		describe("sadd", () => {
			it("should add members to a set", async () => {
				expect(await cache.sadd("s", "a", "b", "c")).toBe(3);
				expect(await cache.scard("s")).toBe(3);
			});

			it("should not count duplicates", async () => {
				await cache.sadd("s", "a", "b");
				expect(await cache.sadd("s", "b", "c")).toBe(1);
			});
		});

		describe("srem", () => {
			it("should remove members from a set", async () => {
				await cache.sadd("s", "a", "b", "c");
				expect(await cache.srem("s", "a", "c")).toBe(2);
				expect(await cache.smembers("s")).toEqual(["b"]);
			});

			it("should return 0 for missing set", async () => {
				expect(await cache.srem("nope", "a")).toBe(0);
			});
		});

		describe("scard", () => {
			it("should return 0 for missing set", async () => {
				expect(await cache.scard("missing")).toBe(0);
			});
		});

		describe("smembers", () => {
			it("should return all members", async () => {
				await cache.sadd("s", "x", "y");
				const members = await cache.smembers("s");
				expect(members.sort()).toEqual(["x", "y"]);
			});

			it("should return empty array for missing set", async () => {
				expect(await cache.smembers("nope")).toEqual([]);
			});
		});
	});
});
