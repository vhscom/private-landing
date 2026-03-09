/**
 * @file gateway-url.test.ts
 * Unit tests for GATEWAY_URL SSRF validation.
 *
 * @license Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { isSafeGatewayUrl } from "../src/types";

describe("isSafeGatewayUrl", () => {
	it("accepts valid HTTP URLs", () => {
		expect(isSafeGatewayUrl("http://gateway:18789")).toBe(true);
		expect(isSafeGatewayUrl("https://gateway.example.com")).toBe(true);
	});

	it("accepts localhost in non-production", () => {
		expect(isSafeGatewayUrl("http://localhost:18789")).toBe(true);
		expect(isSafeGatewayUrl("http://127.0.0.1:18789")).toBe(true);
		expect(isSafeGatewayUrl("http://localhost:18789", "development")).toBe(
			true,
		);
	});

	it("blocks localhost in production", () => {
		expect(isSafeGatewayUrl("http://localhost:18789", "production")).toBe(
			false,
		);
		expect(isSafeGatewayUrl("http://127.0.0.1:18789", "production")).toBe(
			false,
		);
		expect(isSafeGatewayUrl("http://[::1]:18789", "production")).toBe(false);
	});

	it("blocks link-local addresses", () => {
		expect(isSafeGatewayUrl("http://169.254.169.254/metadata")).toBe(false);
		expect(isSafeGatewayUrl("http://169.254.0.1")).toBe(false);
	});

	it("blocks cloud metadata endpoints", () => {
		expect(
			isSafeGatewayUrl("http://metadata.google.internal/computeMetadata"),
		).toBe(false);
		expect(isSafeGatewayUrl("http://metadata.internal")).toBe(false);
	});

	it("blocks non-HTTP schemes", () => {
		expect(isSafeGatewayUrl("ftp://gateway:18789")).toBe(false);
		expect(isSafeGatewayUrl("file:///etc/passwd")).toBe(false);
	});

	it("rejects invalid URLs", () => {
		expect(isSafeGatewayUrl("not-a-url")).toBe(false);
		expect(isSafeGatewayUrl("")).toBe(false);
	});
});
