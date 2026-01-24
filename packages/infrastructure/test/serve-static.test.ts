/**
 * @file serve-static.test.ts
 * Unit tests for static file serving middleware.
 *
 * @license Apache-2.0
 */

import { describe, expect, it, vi } from "vitest";
import { serveStatic } from "../src/middleware/serve-static";

describe("serveStatic", () => {
	describe("middleware creation", () => {
		it("should create middleware with cache option", () => {
			const middleware = serveStatic({ cache: "public, max-age=86400" });
			expect(middleware).toBeDefined();
			expect(typeof middleware).toBe("function");
		});

		it("should create middleware with no-cache option", () => {
			const middleware = serveStatic({ cache: "no-cache, no-store" });
			expect(middleware).toBeDefined();
		});

		it("should create middleware with private cache", () => {
			const middleware = serveStatic({ cache: "private, max-age=3600" });
			expect(middleware).toBeDefined();
		});
	});

	describe("middleware behavior", () => {
		it("should call ASSETS.fetch with request url", async () => {
			const mockFetch = vi
				.fn()
				.mockResolvedValue(new Response("content", { status: 200 }));

			const middleware = serveStatic({ cache: "public" });

			// Create mock context
			const mockCtx = {
				env: {
					ASSETS: { fetch: mockFetch },
				},
				req: {
					url: "http://localhost/test.html",
				},
			};

			const next = vi.fn().mockResolvedValue(undefined);

			const result = await middleware(mockCtx as never, next);

			expect(mockFetch).toHaveBeenCalledWith("http://localhost/test.html");
			expect(result).toBeInstanceOf(Response);
		});

		it("should call next() when response is not ok (404)", async () => {
			const mockFetch = vi
				.fn()
				.mockResolvedValue(new Response("Not Found", { status: 404 }));

			const middleware = serveStatic({ cache: "public" });

			const mockCtx = {
				env: {
					ASSETS: { fetch: mockFetch },
				},
				req: {
					url: "http://localhost/missing.html",
				},
			};

			const next = vi.fn().mockResolvedValue(new Response("fallback"));

			await middleware(mockCtx as never, next);

			expect(next).toHaveBeenCalled();
		});

		it("should call next() when response is 500", async () => {
			const mockFetch = vi
				.fn()
				.mockResolvedValue(new Response("Error", { status: 500 }));

			const middleware = serveStatic({ cache: "public" });

			const mockCtx = {
				env: {
					ASSETS: { fetch: mockFetch },
				},
				req: {
					url: "http://localhost/error.html",
				},
			};

			const next = vi.fn().mockResolvedValue(new Response("fallback"));

			await middleware(mockCtx as never, next);

			expect(next).toHaveBeenCalled();
		});

		it("should return asset response when fetch succeeds", async () => {
			const mockAsset = new Response("file content", {
				status: 200,
				headers: { "Content-Type": "text/html" },
			});
			const mockFetch = vi.fn().mockResolvedValue(mockAsset);

			const middleware = serveStatic({ cache: "public" });

			const mockCtx = {
				env: {
					ASSETS: { fetch: mockFetch },
				},
				req: {
					url: "http://localhost/index.html",
				},
			};

			const next = vi.fn();

			const result = await middleware(mockCtx as never, next);

			expect(next).not.toHaveBeenCalled();
			expect(result).toBeDefined();
		});

		it("should handle nested paths", async () => {
			const mockFetch = vi
				.fn()
				.mockResolvedValue(new Response("css content", { status: 200 }));

			const middleware = serveStatic({ cache: "public" });

			const mockCtx = {
				env: {
					ASSETS: { fetch: mockFetch },
				},
				req: {
					url: "http://localhost/assets/styles/main.css",
				},
			};

			const next = vi.fn();

			await middleware(mockCtx as never, next);

			expect(mockFetch).toHaveBeenCalledWith(
				"http://localhost/assets/styles/main.css",
			);
		});

		it("should not call next() for successful responses", async () => {
			const mockFetch = vi
				.fn()
				.mockResolvedValue(new Response("ok", { status: 200 }));

			const middleware = serveStatic({ cache: "public" });

			const mockCtx = {
				env: {
					ASSETS: { fetch: mockFetch },
				},
				req: {
					url: "http://localhost/app.js",
				},
			};

			const next = vi.fn();

			await middleware(mockCtx as never, next);

			expect(next).not.toHaveBeenCalled();
		});
	});
});
