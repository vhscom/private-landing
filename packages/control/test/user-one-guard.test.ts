/**
 * @file user-one-guard.test.ts
 * Unit tests for user 1 cloaking middleware.
 *
 * @license Apache-2.0
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { userOneGuard } from "../src/middleware/user-one-guard";
import type { ControlEnv } from "../src/types";

function createApp(uid: number) {
	const app = new Hono<ControlEnv>();
	app.use("*", async (ctx, next) => {
		ctx.set("jwtPayload", { uid, sid: "s1", typ: "access" as const });
		return next();
	});
	app.get("*", userOneGuard, (ctx) => ctx.json({ ok: true }));
	return app;
}

describe("userOneGuard", () => {
	it("passes user 1", async () => {
		const res = await createApp(1).request("/test");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it("returns 404 for user 2", async () => {
		const res = await createApp(2).request("/test");
		expect(res.status).toBe(404);
	});

	it("returns 404 for user 0", async () => {
		const res = await createApp(0).request("/test");
		expect(res.status).toBe(404);
	});

	it("returns 404 when uid is missing", async () => {
		const app = new Hono<ControlEnv>();
		app.use("*", async (ctx, next) => {
			// biome-ignore lint/suspicious/noExplicitAny: intentionally incomplete payload
			ctx.set("jwtPayload", {} as any);
			return next();
		});
		app.get("*", userOneGuard, (ctx) => ctx.json({ ok: true }));

		const res = await app.request("/test");
		expect(res.status).toBe(404);
	});
});
