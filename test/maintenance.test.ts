import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/app.ts";

describe("Maintenance Mode", () => {
	const mockConfig = {
		isEnabled: true,
		message: "Test maintenance message",
	};

	const mockEnv = {
		...env,
		HYGRAPH_ENDPOINT: "test-endpoint",
	};

	it("should serve normal page when maintenance mode is disabled", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					data: {
						maintenanceConfig: [
							{
								isEnabled: false,
								message: "",
							},
						],
					},
				}),
			),
		);

		const response = await worker.request("/", {}, mockEnv);
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).not.toContain("Site Maintenance");
	});

	it("should serve maintenance page when enabled", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					data: {
						maintenanceConfig: [
							{
								isEnabled: true,
								message: mockConfig.message,
							},
						],
					},
				}),
			),
		);

		const response = await worker.request("/", {}, mockEnv);
		expect(response.status).toBe(200);
		const html = await response.text();

		// Check content
		expect(html).toContain("Site Maintenance");
		expect(html).toContain(mockConfig.message);

		// Check meta tags
		expect(html).toContain('<meta name="description"');
		expect(html).toContain('<meta charset="utf-8"');

		// Check schema.org
		expect(html).toContain("application/ld+json");
		expect(html).toContain("schema.org");
	});

	it("should handle Hygraph API errors gracefully", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(null, {
				status: 500,
			}),
		);

		const response = await worker.request("/", {}, mockEnv);
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).not.toContain("Site Maintenance");
	});

	it("should handle missing maintenance config gracefully", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					data: {
						maintenanceConfig: [],
					},
				}),
			),
		);

		const response = await worker.request("/", {}, mockEnv);
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).not.toContain("Site Maintenance");
	});

	it("should make GraphQL request with correct headers", async () => {
		const fetchSpy = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					data: {
						maintenanceConfig: [
							{
								isEnabled: true,
								message: mockConfig.message,
							},
						],
					},
				}),
			),
		);
		globalThis.fetch = fetchSpy;

		await worker.request("/", {}, mockEnv);

		expect(fetchSpy).toHaveBeenCalledWith(
			mockEnv.HYGRAPH_ENDPOINT,
			expect.objectContaining({
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
				},
			}),
		);
	});
});
