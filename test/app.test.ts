import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/app.ts";

declare module "cloudflare:test" {
	interface ProvidedEnv extends Env {}
}

describe("Application", () => {
	describe("Basic Routes", () => {
		it("should return 200 for the root path", async () => {
			const response = await worker.request("/", {}, env);
			expect(response.status).toBe(200);
		});

		it("should return proper content type for HTML responses", async () => {
			const response = await worker.request("/", {}, env);
			expect(response.headers.get("Content-Type")).toBe(
				"text/html; charset=utf-8",
			);
		});
	});

	describe("API Endpoints", () => {
		it.skip("should handle JSON requests", async () => {
			const response = await worker.request(
				"/api/hello",
				{
					headers: {
						"Content-Type": "application/json",
					},
				},
				env,
			);

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data).toBeDefined();
		});

		it("should return 404 for non-existent routes", async () => {
			const response = await worker.request("/non-existent-path", {}, env);
			expect(response.status).toBe(404);
		});
	});

	describe("Response Headers", () => {
		it("should include security headers", async () => {
			const { headers } = await worker.request("/", {}, env);

			expect(headers.get("Strict-Transport-Security")).toBe(
				"max-age=31536000; includeSubDomains",
			);
			expect(headers.get("X-Frame-Options")).toBe("deny");
			expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
			expect(headers.get("X-Permitted-Cross-Domain-Policies")).toBe("none");
			expect(headers.get("Referrer-Policy")).toBe("no-referrer");
			expect(headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
			expect(headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
			expect(headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");

			expect(headers.get("Server")).toBeNull();
			expect(headers.get("X-Powered-By")).toBeNull();

			const csp = headers.get("Content-Security-Policy");
			expect(csp).toBeDefined();
			expect(csp).toContain("default-src 'self'");

			const permissionsPolicy = headers.get("Permissions-Policy");
			expect(permissionsPolicy).not.toBeNull();
		});
	});

	describe("Static Asset Serving", () => {
		it("should serve static files with correct content type", async () => {
			const response = await worker.request("/index.html", {}, env);
			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toBe(
				"text/html; charset=utf-8",
			);
		});

		it("should properly handle non-existent static files", async () => {
			const response = await worker.request("/non-existent.jpg", {}, env);
			expect(response.status).toBe(404);
		});

		it("should serve static files from /public/assets", async () => {
			const response = await worker.request("/assets/hello.txt", {}, env);
			expect(response.status).toBe(200);
			expect(await response.text()).toMatch(
				"Me: Hello text.\nText: I'm here...",
			);
		});
	});
});
