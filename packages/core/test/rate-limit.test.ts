/**
 * @file rate-limit.test.ts
 * Unit tests for the rate limiting middleware.
 *
 * @license Apache-2.0
 */

import type {
	CacheClient,
	CacheClientFactory,
} from "@private-landing/infrastructure";
import { createMemoryCacheClient } from "@private-landing/infrastructure";
import type { Env, Variables } from "@private-landing/types";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createRateLimiter } from "../src/auth/middleware/rate-limit";

function buildApp(cacheClientFactory: CacheClientFactory) {
	const rateLimit = createRateLimiter({
		createCacheClient: cacheClientFactory,
		getClientIp: () => "127.0.0.1",
	});

	const app = new Hono<{ Bindings: Env; Variables: Variables }>();
	app.post(
		"/test",
		rateLimit({ windowSeconds: 60, max: 3, prefix: "rl:test" }),
		(ctx) => ctx.json({ ok: true }),
	);
	return app;
}

function request(app: Hono<{ Bindings: Env; Variables: Variables }>) {
	return app.request("/test", { method: "POST" });
}

describe("createRateLimiter", () => {
	it("allows requests within the limit", async () => {
		const cache = createMemoryCacheClient();
		const app = buildApp(() => cache);

		const res = await request(app);
		expect(res.status).toBe(200);
	});

	it("returns 429 when limit is exceeded", async () => {
		const cache = createMemoryCacheClient();
		const app = buildApp(() => cache);

		// Exhaust the limit (max: 3)
		for (let i = 0; i < 3; i++) {
			const res = await request(app);
			expect(res.status).toBe(200);
		}

		// Fourth request should be blocked
		const res = await request(app);
		expect(res.status).toBe(429);
		const body = await res.json();
		expect(body).toEqual({ error: "Too many requests", code: "RATE_LIMIT" });
	});

	it("sets Retry-After header on 429", async () => {
		const cache = createMemoryCacheClient();
		const app = buildApp(() => cache);

		for (let i = 0; i < 3; i++) {
			await request(app);
		}

		const res = await request(app);
		expect(res.status).toBe(429);
		expect(res.headers.get("Retry-After")).toBe("60");
	});

	it("isolates keys by prefix", async () => {
		const cache = createMemoryCacheClient();
		const rateLimit = createRateLimiter({
			createCacheClient: () => cache,
			getClientIp: () => "127.0.0.1",
		});

		const app = new Hono<{ Bindings: Env; Variables: Variables }>();
		app.post(
			"/a",
			rateLimit({ windowSeconds: 60, max: 1, prefix: "rl:a" }),
			(ctx) => ctx.json({ route: "a" }),
		);
		app.post(
			"/b",
			rateLimit({ windowSeconds: 60, max: 1, prefix: "rl:b" }),
			(ctx) => ctx.json({ route: "b" }),
		);

		// First request to each route succeeds
		const resA = await app.request("/a", { method: "POST" });
		expect(resA.status).toBe(200);

		const resB = await app.request("/b", { method: "POST" });
		expect(resB.status).toBe(200);

		// Second request to /a is blocked, /b is also blocked
		const resA2 = await app.request("/a", { method: "POST" });
		expect(resA2.status).toBe(429);

		const resB2 = await app.request("/b", { method: "POST" });
		expect(resB2.status).toBe(429);
	});

	it("isolates keys by client IP", async () => {
		const cache = createMemoryCacheClient();
		let currentIp = "10.0.0.1";
		const rateLimit = createRateLimiter({
			createCacheClient: () => cache,
			getClientIp: () => currentIp,
		});

		const app = new Hono<{ Bindings: Env; Variables: Variables }>();
		app.post(
			"/test",
			rateLimit({ windowSeconds: 60, max: 1, prefix: "rl:test" }),
			(ctx) => ctx.json({ ok: true }),
		);

		// First IP exhausts its limit
		const res1 = await app.request("/test", { method: "POST" });
		expect(res1.status).toBe(200);

		const res2 = await app.request("/test", { method: "POST" });
		expect(res2.status).toBe(429);

		// Second IP still has its own allowance
		currentIp = "10.0.0.2";
		const res3 = await app.request("/test", { method: "POST" });
		expect(res3.status).toBe(200);
	});

	it("uses custom key extractor instead of IP", async () => {
		const cache = createMemoryCacheClient();
		const rateLimit = createRateLimiter({
			createCacheClient: () => cache,
			getClientIp: () => "127.0.0.1",
		});

		const app = new Hono<{ Bindings: Env; Variables: Variables }>();
		let currentUserId = "user-1";
		app.post(
			"/test",
			rateLimit({
				windowSeconds: 60,
				max: 1,
				prefix: "rl:test",
				key: () => currentUserId,
			}),
			(ctx) => ctx.json({ ok: true }),
		);

		// First request for user-1 succeeds
		const res1 = await app.request("/test", { method: "POST" });
		expect(res1.status).toBe(200);

		// Second request for user-1 is blocked
		const res2 = await app.request("/test", { method: "POST" });
		expect(res2.status).toBe(429);

		// Different user on same IP gets independent limit
		currentUserId = "user-2";
		const res3 = await app.request("/test", { method: "POST" });
		expect(res3.status).toBe(200);
	});

	it("passes through when deps is null (no cache configured)", async () => {
		const rateLimit = createRateLimiter(null);

		const app = new Hono<{ Bindings: Env; Variables: Variables }>();
		app.post(
			"/test",
			rateLimit({ windowSeconds: 60, max: 1, prefix: "rl:test" }),
			(ctx) => ctx.json({ ok: true }),
		);

		// All requests pass through — no rate limiting
		for (let i = 0; i < 5; i++) {
			const res = await app.request("/test", { method: "POST" });
			expect(res.status).toBe(200);
		}
	});

	it("fails open when cache throws", async () => {
		const rateLimit = createRateLimiter({
			createCacheClient: () => {
				throw new Error("Cache unavailable");
			},
			getClientIp: () => "127.0.0.1",
		});

		const app = new Hono<{ Bindings: Env; Variables: Variables }>();
		app.post(
			"/test",
			rateLimit({ windowSeconds: 60, max: 1, prefix: "rl:test" }),
			(ctx) => ctx.json({ ok: true }),
		);

		// Request passes through despite cache failure
		const res = await app.request("/test", { method: "POST" });
		expect(res.status).toBe(200);
	});

	it("deletes orphaned key when expire throws", async () => {
		let delCalls = 0;
		const inner = createMemoryCacheClient();
		const tracked: CacheClient = {
			...inner,
			async expire(_key, _ttl) {
				throw new Error("expire failed");
			},
			async del(...keys) {
				delCalls++;
				return inner.del(...keys);
			},
		};

		const app = buildApp(() => tracked);
		const res = await request(app);

		expect(res.status).toBe(200); // fails open
		expect(delCalls).toBe(1); // orphaned key cleaned up
	});

	it("fails open when expire and del both throw", async () => {
		const inner = createMemoryCacheClient();
		const tracked: CacheClient = {
			...inner,
			async expire(_key, _ttl) {
				throw new Error("expire failed");
			},
			async del(..._keys) {
				throw new Error("del failed");
			},
		};

		const app = buildApp(() => tracked);
		const res = await request(app);

		expect(res.status).toBe(200); // still fails open
	});

	it("sets TTL on first request only", async () => {
		let expireCalls = 0;
		const inner = createMemoryCacheClient();
		const tracked: CacheClient = {
			...inner,
			async expire(key, ttl) {
				expireCalls++;
				return inner.expire(key, ttl);
			},
		};

		const app = buildApp(() => tracked);

		await request(app);
		await request(app);
		await request(app);

		expect(expireCalls).toBe(1);
	});
});
