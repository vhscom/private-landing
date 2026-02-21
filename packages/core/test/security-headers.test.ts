/**
 * @file security-headers.test.ts
 * Unit tests for security headers middleware.
 *
 * @license Apache-2.0
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { securityHeaders } from "../src/auth/middleware/security";

describe("securityHeaders middleware", () => {
	function createApp() {
		const app = new Hono();
		app.use("*", securityHeaders);
		app.get("/test", (c) => c.json({ ok: true }));
		app.get("/html", (c) => c.html("<h1>Test</h1>"));
		return app;
	}

	describe("HSTS header", () => {
		it("should set Strict-Transport-Security header", async () => {
			const app = createApp();
			const res = await app.request("/test");

			expect(res.headers.get("Strict-Transport-Security")).toBe(
				"max-age=31536000; includeSubDomains",
			);
		});
	});

	describe("clickjacking protection", () => {
		it("should set X-Frame-Options to deny", async () => {
			const app = createApp();
			const res = await app.request("/test");

			expect(res.headers.get("X-Frame-Options")).toBe("deny");
		});
	});

	describe("MIME sniffing protection", () => {
		it("should set X-Content-Type-Options to nosniff", async () => {
			const app = createApp();
			const res = await app.request("/test");

			expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		});
	});

	describe("Content Security Policy", () => {
		it("should set Content-Security-Policy header", async () => {
			const app = createApp();
			const res = await app.request("/test");

			const csp = res.headers.get("Content-Security-Policy");
			expect(csp).toContain("default-src 'self'");
			expect(csp).toContain("script-src 'self' 'unsafe-inline'");
			expect(csp).toContain("style-src 'self' 'unsafe-inline'");
			expect(csp).toContain("form-action 'self'");
			expect(csp).toContain("object-src 'none'");
			expect(csp).toContain("frame-ancestors 'none'");
			expect(csp).toContain("upgrade-insecure-requests");
			expect(csp).toContain("block-all-mixed-content");
		});
	});

	describe("cross-domain policies", () => {
		it("should set X-Permitted-Cross-Domain-Policies to none", async () => {
			const app = createApp();
			const res = await app.request("/test");

			expect(res.headers.get("X-Permitted-Cross-Domain-Policies")).toBe("none");
		});
	});

	describe("referrer policy", () => {
		it("should set Referrer-Policy to no-referrer", async () => {
			const app = createApp();
			const res = await app.request("/test");

			expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
		});
	});

	describe("cross-origin isolation", () => {
		it("should set Cross-Origin-Embedder-Policy", async () => {
			const app = createApp();
			const res = await app.request("/test");

			expect(res.headers.get("Cross-Origin-Embedder-Policy")).toBe(
				"require-corp",
			);
		});

		it("should set Cross-Origin-Opener-Policy", async () => {
			const app = createApp();
			const res = await app.request("/test");

			expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
		});

		it("should set Cross-Origin-Resource-Policy", async () => {
			const app = createApp();
			const res = await app.request("/test");

			expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe(
				"same-origin",
			);
		});
	});

	describe("permissions policy", () => {
		it("should set Permissions-Policy header", async () => {
			const app = createApp();
			const res = await app.request("/test");

			const policy = res.headers.get("Permissions-Policy");
			expect(policy).toContain("accelerometer=()");
			expect(policy).toContain("camera=()");
			expect(policy).toContain("geolocation=()");
			expect(policy).toContain("microphone=()");
			expect(policy).toContain("payment=()");
			expect(policy).toContain("usb=()");
		});
	});

	describe("cache control", () => {
		it("should set Cache-Control to prevent caching", async () => {
			const app = createApp();
			const res = await app.request("/test");

			expect(res.headers.get("Cache-Control")).toBe("no-store, max-age=0");
		});
	});

	describe("header removal", () => {
		it("should not include Server header", async () => {
			const app = createApp();
			const res = await app.request("/test");

			expect(res.headers.get("Server")).toBeNull();
		});

		it("should not include X-Powered-By header", async () => {
			const app = createApp();
			const res = await app.request("/test");

			expect(res.headers.get("X-Powered-By")).toBeNull();
		});

		it("should not include X-AspNet-Version header", async () => {
			const app = createApp();
			const res = await app.request("/test");

			expect(res.headers.get("X-AspNet-Version")).toBeNull();
		});

		it("should not include X-AspNetMvc-Version header", async () => {
			const app = createApp();
			const res = await app.request("/test");

			expect(res.headers.get("X-AspNetMvc-Version")).toBeNull();
		});
	});

	describe("response preservation", () => {
		it("should preserve response status", async () => {
			const app = new Hono();
			app.use("*", securityHeaders);
			app.get("/created", (c) => c.json({ id: 1 }, 201));

			const res = await app.request("/created");

			expect(res.status).toBe(201);
		});

		it("should preserve response body for JSON", async () => {
			const app = createApp();
			const res = await app.request("/test");

			const body = await res.json();
			expect(body).toEqual({ ok: true });
		});

		it("should preserve response body for HTML", async () => {
			const app = createApp();
			const res = await app.request("/html");

			const body = await res.text();
			expect(body).toBe("<h1>Test</h1>");
		});

		it("should preserve original response headers", async () => {
			const app = new Hono();
			app.use("*", securityHeaders);
			app.get("/custom", (c) => {
				return c.json({ ok: true }, 200, {
					"X-Custom-Header": "custom-value",
				});
			});

			const res = await app.request("/custom");

			expect(res.headers.get("X-Custom-Header")).toBe("custom-value");
		});
	});

	describe("different HTTP methods", () => {
		it("should apply headers to POST requests", async () => {
			const app = new Hono();
			app.use("*", securityHeaders);
			app.post("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test", { method: "POST" });

			expect(res.headers.get("X-Frame-Options")).toBe("deny");
		});

		it("should apply headers to PUT requests", async () => {
			const app = new Hono();
			app.use("*", securityHeaders);
			app.put("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test", { method: "PUT" });

			expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		});
	});
});
