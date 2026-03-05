/**
 * @file schema.test.ts
 * Unit tests for one-time schema initialization.
 *
 * @license Apache-2.0
 */

import type { Env } from "@private-landing/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecute = vi.fn();

vi.mock("@private-landing/infrastructure", () => ({
	createDbClient: vi.fn(() => ({ execute: mockExecute })),
}));

import { _resetSchemaInit, ensureSchema } from "../src/schema";

const env = {
	AUTH_DB_URL: "libsql://test.turso.io",
	AUTH_DB_TOKEN: "test-token",
	JWT_ACCESS_SECRET: "test",
	JWT_REFRESH_SECRET: "test",
} as unknown as Env;

describe("ensureSchema", () => {
	beforeEach(() => {
		_resetSchemaInit();
		mockExecute.mockReset();
		mockExecute.mockResolvedValue({ rows: [], rowsAffected: 0 });
	});

	it("executes CREATE TABLE + CREATE INDEX statements on first call", async () => {
		await ensureSchema(env);
		// 1 table + 4 event indices + 1 table + 1 agent index = 7
		expect(mockExecute).toHaveBeenCalledTimes(7);
		expect(mockExecute.mock.calls[0][0].sql).toContain("security_event");
		expect(mockExecute.mock.calls[1][0].sql).toContain(
			"idx_security_event_type",
		);
		expect(mockExecute.mock.calls[4][0].sql).toContain("idx_security_event_ip");
		expect(mockExecute.mock.calls[5][0].sql).toContain("agent_credential");
		expect(mockExecute.mock.calls[6][0].sql).toContain(
			"idx_agent_credential_name",
		);
	});

	it("is a no-op on subsequent calls", async () => {
		await ensureSchema(env);
		expect(mockExecute).toHaveBeenCalledTimes(7);

		mockExecute.mockClear();
		await ensureSchema(env);
		expect(mockExecute).not.toHaveBeenCalled();
	});

	it("retries on next call if first call threw an error", async () => {
		mockExecute.mockRejectedValueOnce(new Error("DB down"));
		await ensureSchema(env);

		mockExecute.mockReset();
		mockExecute.mockResolvedValue({ rows: [], rowsAffected: 0 });
		await ensureSchema(env);
		expect(mockExecute).toHaveBeenCalledTimes(7);
	});

	it("logs error but does not throw when DB fails", async () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		mockExecute.mockRejectedValueOnce(new Error("DB down"));

		await expect(ensureSchema(env)).resolves.toBeUndefined();
		expect(consoleSpy).toHaveBeenCalledWith(
			"[obs] schema initialization failed:",
			expect.any(Error),
		);
		consoleSpy.mockRestore();
	});
});
