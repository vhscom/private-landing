/**
 * @file ip-allowlist.test.ts
 * Unit tests for IP allowlist middleware.
 *
 * @license Apache-2.0
 */

import type { GetClientIpFn } from "@private-landing/types";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createIpAllowlist } from "../src/middleware/ip-allowlist";
import type { ControlBindings } from "../src/types";

type AppEnv = { Bindings: ControlBindings };

function createApp(
	allowedIps: string | undefined,
	getClientIp?: GetClientIpFn,
) {
	const app = new Hono<AppEnv>();
	const mw = createIpAllowlist(getClientIp);
	app.get("*", mw, (ctx) => ctx.json({ ok: true }));

	const env: Record<string, string> = {
		TURSO_URL: "libsql://test",
		TURSO_AUTH_TOKEN: "test",
		JWT_SECRET: "test",
	};
	if (allowedIps !== undefined) {
		env.CONTROL_ALLOWED_IPS = allowedIps;
	}

	return { app, env };
}

function request(
	app: Hono<AppEnv>,
	env: Record<string, string>,
	path = "/test",
) {
	return app.request(path, {}, env);
}

describe("createIpAllowlist", () => {
	it("passes all traffic when CONTROL_ALLOWED_IPS is unset", async () => {
		const { app, env } = createApp(undefined);
		const res = await request(app, env);
		expect(res.status).toBe(200);
	});

	it("passes all traffic when CONTROL_ALLOWED_IPS is empty", async () => {
		const { app, env } = createApp("");
		const res = await request(app, env);
		expect(res.status).toBe(200);
	});

	it("passes matching IP", async () => {
		const getIp = vi.fn(() => "10.0.0.1") as unknown as GetClientIpFn;
		const { app, env } = createApp("10.0.0.1,192.168.1.1", getIp);
		const res = await request(app, env);
		expect(res.status).toBe(200);
	});

	it("returns 404 for non-matching IP", async () => {
		const getIp = vi.fn(() => "10.0.0.99") as unknown as GetClientIpFn;
		const { app, env } = createApp("10.0.0.1", getIp);
		const res = await request(app, env);
		expect(res.status).toBe(404);
	});

	it("returns 404 when no getClientIp function is provided", async () => {
		const { app, env } = createApp("10.0.0.1");
		const res = await request(app, env);
		expect(res.status).toBe(404);
	});

	it("handles whitespace in allowed IPs", async () => {
		const getIp = vi.fn(() => "10.0.0.1") as unknown as GetClientIpFn;
		const { app, env } = createApp(" 10.0.0.1 , 10.0.0.2 ", getIp);
		const res = await request(app, env);
		expect(res.status).toBe(200);
	});

	it("passes through when CONTROL_ALLOWED_IPS is only commas", async () => {
		const { app, env } = createApp(",,,");
		const res = await request(app, env);
		expect(res.status).toBe(200);
	});

	it("returns 404 when getClientIp throws", async () => {
		const getIp = vi.fn(() => {
			throw new Error("header missing");
		}) as unknown as GetClientIpFn;
		const { app, env } = createApp("10.0.0.1", getIp);
		const res = await request(app, env);
		expect(res.status).toBe(404);
	});
});
