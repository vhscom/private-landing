/**
 * @file negotiate.test.ts
 * Unit tests for content negotiation utilities.
 *
 * @license Apache-2.0
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { parseRequestBody, wantsJson } from "./negotiate";

/**
 * Helper that creates a minimal Hono context with the given Accept header.
 */
async function ctxWithAccept(accept: string | undefined): Promise<boolean> {
	let captured: boolean | undefined;
	const app = new Hono();
	app.post("/test", (ctx) => {
		captured = wantsJson(ctx);
		return ctx.text("ok");
	});

	const headers: Record<string, string> = {};
	if (accept !== undefined) {
		headers.Accept = accept;
	}

	await app.request("/test", { method: "POST", headers });
	return captured as boolean;
}

describe("wantsJson", () => {
	it("returns true for application/json", async () => {
		expect(await ctxWithAccept("application/json")).toBe(true);
	});

	it("returns true when application/json is among multiple types", async () => {
		expect(await ctxWithAccept("text/html, application/json, text/plain")).toBe(
			true,
		);
	});

	it("returns false for */*", async () => {
		expect(await ctxWithAccept("*/*")).toBe(false);
	});

	it("returns false for text/html", async () => {
		expect(await ctxWithAccept("text/html")).toBe(false);
	});

	it("returns false when no Accept header is set", async () => {
		expect(await ctxWithAccept(undefined)).toBe(false);
	});
});

describe("parseRequestBody", () => {
	it("parses JSON body when Content-Type is application/json", async () => {
		let captured: Record<string, string> | undefined;
		const app = new Hono();
		app.post("/test", async (ctx) => {
			captured = await parseRequestBody(ctx);
			return ctx.text("ok");
		});

		await app.request("/test", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "a@b.com", password: "secret" }),
		});

		expect(captured).toEqual({ email: "a@b.com", password: "secret" });
	});

	it("parses form data when Content-Type is not JSON", async () => {
		let captured: Record<string, string> | undefined;
		const app = new Hono();
		app.post("/test", async (ctx) => {
			captured = await parseRequestBody(ctx);
			return ctx.text("ok");
		});

		const formData = new FormData();
		formData.set("email", "a@b.com");
		formData.set("password", "secret");

		await app.request("/test", {
			method: "POST",
			body: formData,
		});

		expect(captured).toEqual({ email: "a@b.com", password: "secret" });
	});
});
