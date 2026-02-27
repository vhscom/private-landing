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

vi.mock("../src/process-event", () => ({
	APP_ACTOR_ID: "app:private-landing",
	processEvent: (...args: unknown[]) => mockProcessEvent(...args),
}));

import { createObsEmit } from "../src/middleware";

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
