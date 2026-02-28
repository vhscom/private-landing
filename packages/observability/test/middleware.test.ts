/**
 * @file middleware.test.ts
 * Unit tests for obsEmit event emission middleware (ADR-008).
 *
 * @license Apache-2.0
 */

import type { Env, Variables } from "@private-landing/types";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProcessEvent = vi.fn().mockResolvedValue(undefined);
const mockComputeChallenge = vi.fn().mockResolvedValue(null);

vi.mock("../src/process-event", () => ({
	APP_ACTOR_ID: "app:private-landing",
	processEvent: (...args: unknown[]) => mockProcessEvent(...args),
	computeChallenge: (...args: unknown[]) => mockComputeChallenge(...args),
}));

import { createAdaptiveChallenge, createObsEmit } from "../src/middleware";

type AppEnv = {
	Bindings: Env;
	Variables: Variables;
};

const baseEnv = {
	AUTH_DB_URL: "libsql://test.turso.io",
	AUTH_DB_TOKEN: "test-token",
	JWT_ACCESS_SECRET: "test",
	JWT_REFRESH_SECRET: "test",
} as AppEnv["Bindings"];

describe("createObsEmit", () => {
	beforeEach(() => {
		mockProcessEvent.mockReset().mockResolvedValue(undefined);
	});

	it("calls processEvent after handler", async () => {
		const obsEmit = createObsEmit({ getClientIp: () => "1.2.3.4" });
		const app = new Hono<AppEnv>();
		app.post("/login", obsEmit("login.success"), (ctx) =>
			ctx.json({ ok: true }),
		);

		await app.request("/login", { method: "POST" }, baseEnv);

		expect(mockProcessEvent).toHaveBeenCalledTimes(1);
		const [event, deps] = mockProcessEvent.mock.calls[0];
		expect(event.type).toBe("login.success");
		expect(event.ipAddress).toBe("1.2.3.4");
		expect(event.status).toBe(200);
		expect(deps.env).toEqual(baseEnv);
	});

	it("resolves login.success to login.failure when status >= 400", async () => {
		const obsEmit = createObsEmit({ getClientIp: () => "1.2.3.4" });
		const app = new Hono<AppEnv>();
		app.post("/login", obsEmit("login.success"), (ctx) =>
			ctx.json({ error: "bad" }, 401),
		);

		await app.request("/login", { method: "POST" }, baseEnv);

		const [event] = mockProcessEvent.mock.calls[0];
		expect(event.type).toBe("login.failure");
		expect(event.status).toBe(401);
	});

	it("uses 'unknown' as ipAddress when getClientIp is not provided", async () => {
		const obsEmit = createObsEmit();
		const app = new Hono<AppEnv>();
		app.post("/login", obsEmit("login.success"), (ctx) =>
			ctx.json({ ok: true }),
		);

		await app.request("/login", { method: "POST" }, baseEnv);

		const [event] = mockProcessEvent.mock.calls[0];
		expect(event.ipAddress).toBe("unknown");
	});

	it("resolves registration.success to registration.failure when status >= 400", async () => {
		const obsEmit = createObsEmit({ getClientIp: () => "1.2.3.4" });
		const app = new Hono<AppEnv>();
		app.post("/register", obsEmit("registration.success"), (ctx) =>
			ctx.json({ error: "bad" }, 400),
		);

		await app.request("/register", { method: "POST" }, baseEnv);

		const [event] = mockProcessEvent.mock.calls[0];
		expect(event.type).toBe("registration.failure");
		expect(event.status).toBe(400);
	});

	it("keeps non-.success event types unchanged on error status", async () => {
		const obsEmit = createObsEmit({ getClientIp: () => "1.2.3.4" });
		const app = new Hono<AppEnv>();
		app.post("/test", obsEmit("session.revoke"), (ctx) =>
			ctx.json({ error: "bad" }, 500),
		);

		await app.request("/test", { method: "POST" }, baseEnv);

		const [event] = mockProcessEvent.mock.calls[0];
		expect(event.type).toBe("session.revoke");
	});

	it("uses custom actorId when provided in deps", async () => {
		const obsEmit = createObsEmit({
			getClientIp: () => "1.2.3.4",
			actorId: "app:custom",
		});
		const app = new Hono<AppEnv>();
		app.post("/login", obsEmit("login.success"), (ctx) =>
			ctx.json({ ok: true }),
		);

		await app.request("/login", { method: "POST" }, baseEnv);

		const [event] = mockProcessEvent.mock.calls[0];
		expect(event.actorId).toBe("app:custom");
	});
});

describe("createAdaptiveChallenge", () => {
	beforeEach(() => {
		mockComputeChallenge.mockReset().mockResolvedValue(null);
		mockProcessEvent.mockReset().mockResolvedValue(undefined);
	});

	it("passes custom eventType to computeChallenge", async () => {
		const middleware = createAdaptiveChallenge(() => "1.2.3.4", {
			eventType: "registration.failure",
		});
		const app = new Hono<AppEnv>();
		app.post("/register", middleware, (ctx) => ctx.json({ ok: true }));

		await app.request("/register", { method: "POST" }, baseEnv);

		expect(mockComputeChallenge).toHaveBeenCalledWith(
			"1.2.3.4",
			baseEnv,
			expect.any(Object),
			"registration.failure",
		);
	});

	it("passes undefined eventType when opts not provided", async () => {
		const middleware = createAdaptiveChallenge(() => "1.2.3.4");
		const app = new Hono<AppEnv>();
		app.post("/login", middleware, (ctx) => ctx.json({ ok: true }));

		await app.request("/login", { method: "POST" }, baseEnv);

		expect(mockComputeChallenge).toHaveBeenCalledWith(
			"1.2.3.4",
			baseEnv,
			expect.any(Object),
			undefined,
		);
	});

	it("returns 403 with challenge.issued for non-JSON request", async () => {
		mockComputeChallenge.mockResolvedValue({
			type: "pow",
			difficulty: 1,
			nonce: "test-nonce",
		});
		const middleware = createAdaptiveChallenge(() => "1.2.3.4");
		const app = new Hono<AppEnv>();
		app.post("/login", middleware, (ctx) => ctx.json({ ok: true }));

		const execCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
		const res = await app.request(
			"/login",
			{
				method: "POST",
				headers: { "Content-Type": "text/plain" },
				body: "hello",
			},
			baseEnv,
			execCtx,
		);

		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error).toBe("Challenge required");
		expect(body.challenge.nonce).toBe("test-nonce");
		expect(mockProcessEvent).toHaveBeenCalledWith(
			expect.objectContaining({ type: "challenge.issued", status: 403 }),
			expect.anything(),
		);
	});

	it("returns 403 with challenge.issued when nonce/solution missing", async () => {
		mockComputeChallenge.mockResolvedValue({
			type: "pow",
			difficulty: 1,
			nonce: "test-nonce",
		});
		const middleware = createAdaptiveChallenge(() => "1.2.3.4");
		const app = new Hono<AppEnv>();
		app.post("/login", middleware, (ctx) => ctx.json({ ok: true }));

		const execCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
		const res = await app.request(
			"/login",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ username: "user" }),
			},
			baseEnv,
			execCtx,
		);

		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error).toBe("Challenge required");
		expect(mockProcessEvent).toHaveBeenCalledWith(
			expect.objectContaining({ type: "challenge.issued" }),
			expect.anything(),
		);
	});

	it("returns 403 with challenge.failed for wrong solution", async () => {
		mockComputeChallenge.mockResolvedValue({
			type: "pow",
			difficulty: 4,
			nonce: "test-nonce",
		});
		const middleware = createAdaptiveChallenge(() => "1.2.3.4");
		const app = new Hono<AppEnv>();
		app.post("/login", middleware, (ctx) => ctx.json({ ok: true }));

		const execCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
		const res = await app.request(
			"/login",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					challengeNonce: "test-nonce",
					challengeSolution: "wrong-answer",
				}),
			},
			baseEnv,
			execCtx,
		);

		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error).toBe("Invalid solution");
		expect(mockProcessEvent).toHaveBeenCalledWith(
			expect.objectContaining({ type: "challenge.failed" }),
			expect.anything(),
		);
	});

	it("passes through to next() with valid PoW solution", async () => {
		const nonce = "test-nonce";
		const difficulty = 1;
		mockComputeChallenge.mockResolvedValue({
			type: "pow",
			difficulty,
			nonce,
		});

		// Brute-force a valid solution for difficulty 1
		const prefix = "0".repeat(difficulty);
		let solution = "";
		for (let i = 0; i < 100000; i++) {
			const candidate = String(i);
			const hash = Array.from(
				new Uint8Array(
					await crypto.subtle.digest(
						"SHA-256",
						new TextEncoder().encode(nonce + candidate),
					),
				),
			)
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
			if (hash.startsWith(prefix)) {
				solution = candidate;
				break;
			}
		}

		const middleware = createAdaptiveChallenge(() => "1.2.3.4");
		const app = new Hono<AppEnv>();
		app.post("/login", middleware, (ctx) => ctx.json({ ok: true }));

		const res = await app.request(
			"/login",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					challengeNonce: nonce,
					challengeSolution: solution,
				}),
			},
			baseEnv,
		);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
	});

	it("fails open when computeChallenge rejects", async () => {
		mockComputeChallenge.mockRejectedValue(new Error("DB down"));
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const middleware = createAdaptiveChallenge(() => "1.2.3.4");
		const app = new Hono<AppEnv>();
		app.post("/login", middleware, (ctx) => ctx.json({ ok: true }));

		const res = await app.request("/login", { method: "POST" }, baseEnv);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining("[obs] adaptive challenge error:"),
			expect.any(Error),
		);

		consoleSpy.mockRestore();
	});
});
