/**
 * @file session-config.test.ts
 * Unit tests for session configuration.
 *
 * @license Apache-2.0
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
	createSessionConfig,
	defaultSessionConfig,
} from "../src/auth/config/session-config";

function createTestContext() {
	const app = new Hono();
	// biome-ignore lint/suspicious/noExplicitAny: Test utility
	let capturedCtx: any = null;

	app.get("/test", (ctx) => {
		capturedCtx = ctx;
		return ctx.json({ ok: true });
	});

	return {
		async getContext() {
			await app.request("/test");
			return capturedCtx;
		},
	};
}

describe("defaultSessionConfig", () => {
	it("should have maxSessions set to 3", () => {
		expect(defaultSessionConfig.maxSessions).toBe(3);
	});

	it("should have sessionDuration set to 7 days in seconds", () => {
		expect(defaultSessionConfig.sessionDuration).toBe(60 * 60 * 24 * 7);
	});

	it("should have maintenanceWindow set to 30 days", () => {
		expect(defaultSessionConfig.maintenanceWindow).toBe(30);
	});

	it("should have secure cookie settings", () => {
		expect(defaultSessionConfig.cookie.httpOnly).toBe(true);
		expect(defaultSessionConfig.cookie.secure).toBe(true);
		expect(defaultSessionConfig.cookie.sameSite).toBe("Strict");
		expect(defaultSessionConfig.cookie.path).toBe("/");
		expect(defaultSessionConfig.cookie.partitioned).toBe(true);
	});

	it("should have cookie maxAge matching sessionDuration", () => {
		expect(defaultSessionConfig.cookie.maxAge).toBe(
			defaultSessionConfig.sessionDuration,
		);
	});
});

describe("createSessionConfig", () => {
	it("should return default config when no overrides provided", async () => {
		const { getContext } = createTestContext();
		const ctx = await getContext();

		const config = createSessionConfig(ctx);

		expect(config).toEqual(defaultSessionConfig);
	});

	it("should override maxSessions", async () => {
		const { getContext } = createTestContext();
		const ctx = await getContext();

		const config = createSessionConfig(ctx, { maxSessions: 5 });

		expect(config.maxSessions).toBe(5);
		expect(config.sessionDuration).toBe(defaultSessionConfig.sessionDuration);
	});

	it("should override sessionDuration", async () => {
		const { getContext } = createTestContext();
		const ctx = await getContext();

		const config = createSessionConfig(ctx, { sessionDuration: 3600 });

		expect(config.sessionDuration).toBe(3600);
		expect(config.maxSessions).toBe(defaultSessionConfig.maxSessions);
	});

	it("should override maintenanceWindow", async () => {
		const { getContext } = createTestContext();
		const ctx = await getContext();

		const config = createSessionConfig(ctx, { maintenanceWindow: 60 });

		expect(config.maintenanceWindow).toBe(60);
	});

	it("should override cookie settings while preserving defaults", async () => {
		const { getContext } = createTestContext();
		const ctx = await getContext();

		const config = createSessionConfig(ctx, {
			cookie: { maxAge: 1800 },
		});

		expect(config.cookie.maxAge).toBe(1800);
		expect(config.cookie.httpOnly).toBe(true);
		expect(config.cookie.secure).toBe(true);
		expect(config.cookie.sameSite).toBe("Strict");
	});

	it("should handle multiple cookie overrides", async () => {
		const { getContext } = createTestContext();
		const ctx = await getContext();

		const config = createSessionConfig(ctx, {
			cookie: {
				secure: false,
				sameSite: "Lax",
				path: "/api",
			},
		});

		expect(config.cookie.secure).toBe(false);
		expect(config.cookie.sameSite).toBe("Lax");
		expect(config.cookie.path).toBe("/api");
		expect(config.cookie.httpOnly).toBe(true);
	});

	it("should handle combined overrides", async () => {
		const { getContext } = createTestContext();
		const ctx = await getContext();

		const config = createSessionConfig(ctx, {
			maxSessions: 10,
			sessionDuration: 7200,
			cookie: { maxAge: 7200 },
		});

		expect(config.maxSessions).toBe(10);
		expect(config.sessionDuration).toBe(7200);
		expect(config.cookie.maxAge).toBe(7200);
	});

	it("should handle undefined overrides", async () => {
		const { getContext } = createTestContext();
		const ctx = await getContext();

		const config = createSessionConfig(ctx, undefined);

		expect(config).toEqual(defaultSessionConfig);
	});

	it("should handle empty overrides object", async () => {
		const { getContext } = createTestContext();
		const ctx = await getContext();

		const config = createSessionConfig(ctx, {});

		expect(config).toEqual(defaultSessionConfig);
	});
});
