/**
 * @file db-client.test.ts
 * Unit tests for database client factory.
 *
 * @license Apache-2.0
 */

import { createClient } from "@libsql/client";
import { describe, expect, it, vi } from "vitest";
import { createDbClient } from "../src/db/client";

// Mock @libsql/client
vi.mock("@libsql/client", () => ({
	createClient: vi.fn(() => ({
		execute: vi.fn(),
		batch: vi.fn(),
		close: vi.fn(),
	})),
}));

const mockCreateClient = vi.mocked(createClient);

describe("createDbClient", () => {
	describe("successful creation", () => {
		it("should create client with valid url and token", () => {
			const env = {
				AUTH_DB_URL: "libsql://test.turso.io",
				AUTH_DB_TOKEN: "test-token-123",
			};

			const client = createDbClient(env as never);

			expect(client).toBeDefined();
			expect(mockCreateClient).toHaveBeenCalledWith({
				url: "libsql://test.turso.io",
				authToken: "test-token-123",
			});
		});

		it("should trim whitespace from url", () => {
			const env = {
				AUTH_DB_URL: "  libsql://test.turso.io  ",
				AUTH_DB_TOKEN: "test-token",
			};

			createDbClient(env as never);

			expect(mockCreateClient).toHaveBeenCalledWith({
				url: "libsql://test.turso.io",
				authToken: "test-token",
			});
		});

		it("should trim whitespace from auth token", () => {
			const env = {
				AUTH_DB_URL: "libsql://test.turso.io",
				AUTH_DB_TOKEN: "  test-token  ",
			};

			createDbClient(env as never);

			expect(mockCreateClient).toHaveBeenCalledWith({
				url: "libsql://test.turso.io",
				authToken: "test-token",
			});
		});

		it("should handle url with trailing newline", () => {
			const env = {
				AUTH_DB_URL: "libsql://test.turso.io\n",
				AUTH_DB_TOKEN: "test-token",
			};

			createDbClient(env as never);

			expect(mockCreateClient).toHaveBeenCalledWith({
				url: "libsql://test.turso.io",
				authToken: "test-token",
			});
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

		it("should throw error when auth token is missing for remote url", () => {
			const env = {
				AUTH_DB_URL: "libsql://test.turso.io",
			};

			expect(() => createDbClient(env as never)).toThrow(
				"No auth token provided",
			);
		});

		it("should throw error when auth token is undefined for remote url", () => {
			const env = {
				AUTH_DB_URL: "libsql://test.turso.io",
				AUTH_DB_TOKEN: undefined,
			};

			expect(() => createDbClient(env as never)).toThrow(
				"No auth token provided",
			);
		});

		it("should throw error when auth token is empty string for remote url", () => {
			const env = {
				AUTH_DB_URL: "libsql://test.turso.io",
				AUTH_DB_TOKEN: "",
			};

			expect(() => createDbClient(env as never)).toThrow(
				"No auth token provided",
			);
		});

		it("should throw error when auth token is whitespace only for remote url", () => {
			const env = {
				AUTH_DB_URL: "libsql://test.turso.io",
				AUTH_DB_TOKEN: "   ",
			};

			expect(() => createDbClient(env as never)).toThrow(
				"No auth token provided",
			);
		});
	});

	describe("local database urls", () => {
		it("should create client for file: url without auth token", () => {
			const env = {
				AUTH_DB_URL: "file:local.db",
			};

			createDbClient(env as never);

			expect(mockCreateClient).toHaveBeenCalledWith({ url: "file:local.db" });
		});

		it("should create client for file: url with absolute path", () => {
			const env = {
				AUTH_DB_URL: "file:/tmp/test.db",
			};

			createDbClient(env as never);

			expect(mockCreateClient).toHaveBeenCalledWith({
				url: "file:/tmp/test.db",
			});
		});

		it("should create client for :memory: url without auth token", () => {
			const env = {
				AUTH_DB_URL: ":memory:",
			};

			createDbClient(env as never);

			expect(mockCreateClient).toHaveBeenCalledWith({ url: ":memory:" });
		});
	});

	describe("edge cases", () => {
		it("should handle url with special characters", () => {
			const env = {
				AUTH_DB_URL: "libsql://my-db-123.turso.io",
				AUTH_DB_TOKEN: "token",
			};

			createDbClient(env as never);

			expect(mockCreateClient).toHaveBeenCalledWith({
				url: "libsql://my-db-123.turso.io",
				authToken: "token",
			});
		});

		it("should handle token with special characters", () => {
			const env = {
				AUTH_DB_URL: "libsql://test.turso.io",
				AUTH_DB_TOKEN: "eyJhbGciOiJIUzI1NiJ9.token+value/special=",
			};

			createDbClient(env as never);

			expect(mockCreateClient).toHaveBeenCalledWith({
				url: "libsql://test.turso.io",
				authToken: "eyJhbGciOiJIUzI1NiJ9.token+value/special=",
			});
		});
	});
});
