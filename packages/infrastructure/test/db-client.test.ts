/**
 * @file db-client.test.ts
 * Unit tests for database client factory.
 *
 * @license Apache-2.0
 */

import { describe, expect, it, vi } from "vitest";
import { createDbClient } from "../src/db/client";

// Mock @libsql/client
vi.mock("@libsql/client", () => ({
	createClient: vi.fn((config: { url: string; authToken: string }) => ({
		url: config.url,
		authToken: config.authToken,
		execute: vi.fn(),
		batch: vi.fn(),
		close: vi.fn(),
	})),
}));

describe("createDbClient", () => {
	describe("successful creation", () => {
		it("should create client with valid url and token", () => {
			const env = {
				AUTH_DB_URL: "libsql://test.turso.io",
				AUTH_DB_TOKEN: "test-token-123",
			};

			const client = createDbClient(env as never);

			expect(client).toBeDefined();
			expect(client.url).toBe("libsql://test.turso.io");
			expect(client.authToken).toBe("test-token-123");
		});

		it("should trim whitespace from url", () => {
			const env = {
				AUTH_DB_URL: "  libsql://test.turso.io  ",
				AUTH_DB_TOKEN: "test-token",
			};

			const client = createDbClient(env as never);

			expect(client.url).toBe("libsql://test.turso.io");
		});

		it("should trim whitespace from auth token", () => {
			const env = {
				AUTH_DB_URL: "libsql://test.turso.io",
				AUTH_DB_TOKEN: "  test-token  ",
			};

			const client = createDbClient(env as never);

			expect(client.authToken).toBe("test-token");
		});

		it("should handle url with trailing newline", () => {
			const env = {
				AUTH_DB_URL: "libsql://test.turso.io\n",
				AUTH_DB_TOKEN: "test-token",
			};

			const client = createDbClient(env as never);

			expect(client.url).toBe("libsql://test.turso.io");
		});
	});

	describe("missing configuration", () => {
		it("should throw error when url is missing", () => {
			const env = {
				AUTH_DB_TOKEN: "test-token",
			};

			expect(() => createDbClient(env as never)).toThrow("No URL");
		});

		it("should throw error when url is undefined", () => {
			const env = {
				AUTH_DB_URL: undefined,
				AUTH_DB_TOKEN: "test-token",
			};

			expect(() => createDbClient(env as never)).toThrow("No URL");
		});

		it("should throw error when url is empty string", () => {
			const env = {
				AUTH_DB_URL: "",
				AUTH_DB_TOKEN: "test-token",
			};

			expect(() => createDbClient(env as never)).toThrow("No URL");
		});

		it("should throw error when url is whitespace only", () => {
			const env = {
				AUTH_DB_URL: "   ",
				AUTH_DB_TOKEN: "test-token",
			};

			expect(() => createDbClient(env as never)).toThrow("No URL");
		});

		it("should throw error when auth token is missing", () => {
			const env = {
				AUTH_DB_URL: "libsql://test.turso.io",
			};

			expect(() => createDbClient(env as never)).toThrow(
				"No auth token provided",
			);
		});

		it("should throw error when auth token is undefined", () => {
			const env = {
				AUTH_DB_URL: "libsql://test.turso.io",
				AUTH_DB_TOKEN: undefined,
			};

			expect(() => createDbClient(env as never)).toThrow(
				"No auth token provided",
			);
		});

		it("should throw error when auth token is empty string", () => {
			const env = {
				AUTH_DB_URL: "libsql://test.turso.io",
				AUTH_DB_TOKEN: "",
			};

			expect(() => createDbClient(env as never)).toThrow(
				"No auth token provided",
			);
		});

		it("should throw error when auth token is whitespace only", () => {
			const env = {
				AUTH_DB_URL: "libsql://test.turso.io",
				AUTH_DB_TOKEN: "   ",
			};

			expect(() => createDbClient(env as never)).toThrow(
				"No auth token provided",
			);
		});
	});

	describe("edge cases", () => {
		it("should handle url with special characters", () => {
			const env = {
				AUTH_DB_URL: "libsql://my-db-123.turso.io",
				AUTH_DB_TOKEN: "token",
			};

			const client = createDbClient(env as never);

			expect(client.url).toBe("libsql://my-db-123.turso.io");
		});

		it("should handle token with special characters", () => {
			const env = {
				AUTH_DB_URL: "libsql://test.turso.io",
				AUTH_DB_TOKEN: "eyJhbGciOiJIUzI1NiJ9.token+value/special=",
			};

			const client = createDbClient(env as never);

			expect(client.authToken).toBe(
				"eyJhbGciOiJIUzI1NiJ9.token+value/special=",
			);
		});
	});
});
