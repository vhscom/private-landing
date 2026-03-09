/**
 * @file proxy.test.ts
 * Unit tests for the gateway reverse proxy.
 *
 * @license Apache-2.0
 */

import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyToGateway } from "../src/proxy";

// Mock global fetch
const fetchSpy = vi.spyOn(globalThis, "fetch");

afterEach(() => {
	fetchSpy.mockReset();
});

function createApp(gatewayUrl: string) {
	const app = new Hono();
	app.all("/ops/control/*", async (ctx) => proxyToGateway(ctx, gatewayUrl));
	return app;
}

describe("proxyToGateway", () => {
	it("proxies successful responses", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response('{"status":"ok"}', {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const app = createApp("http://gateway:18789");
		const res = await app.request("/ops/control/dashboard");

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok" });

		// Verify the URL was rewritten
		const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
		expect(calledUrl).toContain("gateway:18789");
		expect(calledUrl).toContain("/dashboard");
		expect(calledUrl).not.toContain("/ops/control");
	});

	it("returns 502 on gateway error response", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response("Internal Server Error", { status: 500 }),
		);

		const app = createApp("http://gateway:18789");
		const res = await app.request("/ops/control/api");

		expect(res.status).toBe(502);
		const body = await res.json();
		expect(body).toEqual({ error: "Bad Gateway" });
	});

	it("returns 502 on network failure", async () => {
		fetchSpy.mockRejectedValueOnce(new Error("Connection refused"));

		const app = createApp("http://gateway:18789");
		const res = await app.request("/ops/control/api");

		expect(res.status).toBe(502);
		const body = await res.json();
		expect(body).toEqual({ error: "Bad Gateway" });
	});

	it("strips Cookie and Authorization headers before forwarding", async () => {
		fetchSpy.mockResolvedValueOnce(new Response("ok", { status: 200 }));

		const app = createApp("http://gateway:18789");
		await app.request("/ops/control/dashboard", {
			headers: {
				Cookie: "access_token=secret; refresh_token=secret",
				Authorization: "Bearer leaked",
				Accept: "text/html",
			},
		});

		const calledInit = fetchSpy.mock.calls[0]?.[1] as RequestInit;
		const fwdHeaders = new Headers(calledInit.headers);
		expect(fwdHeaders.get("cookie")).toBeNull();
		expect(fwdHeaders.get("authorization")).toBeNull();
		expect(fwdHeaders.get("accept")).toBe("text/html");
	});

	it("returns 502 for unsafe GATEWAY_URL", async () => {
		const app = createApp("ftp://evil:18789");
		const res = await app.request("/ops/control/dashboard");

		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ error: "Bad Gateway" });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("does not leak gateway error details", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({ stack: "Error: secret info at /internal/path" }),
				{ status: 500 },
			),
		);

		const app = createApp("http://gateway:18789");
		const res = await app.request("/ops/control/api");

		expect(res.status).toBe(502);
		const text = await res.text();
		expect(text).not.toContain("secret");
		expect(text).not.toContain("internal");
	});
});
