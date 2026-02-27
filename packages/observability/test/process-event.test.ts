/**
 * @file process-event.test.ts
 * Unit tests for direct event processing (ADR-008).
 *
 * @license Apache-2.0
 */

import type { Env } from "@private-landing/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecute = vi.fn();
const mockEnsureSchema = vi.fn();

vi.mock("@private-landing/infrastructure", () => ({
	createDbClient: vi.fn(() => ({ execute: mockExecute })),
}));

vi.mock("../src/schema", () => ({
	ensureSchema: (...args: unknown[]) => mockEnsureSchema(...args),
}));

import {
	APP_ACTOR_ID,
	processEvent,
	type SecurityEvent,
} from "../src/process-event";

const baseEnv: Env = {
	AUTH_DB_URL: "libsql://test.turso.io",
	AUTH_DB_TOKEN: "test-token",
	JWT_ACCESS_SECRET: "test",
	JWT_REFRESH_SECRET: "test",
};

function makeEvent(overrides: Partial<SecurityEvent> = {}): SecurityEvent {
	return {
		type: "login.success",
		created_at: "2026-02-27T00:00:00Z",
		ipAddress: "1.2.3.4",
		ua: "test-agent",
		status: 200,
		...overrides,
	};
}

describe("processEvent", () => {
	beforeEach(() => {
		mockExecute.mockReset();
		mockEnsureSchema.mockReset();
	});

	it("inserts into security_event", async () => {
		mockExecute.mockResolvedValue({ rows: [], rowsAffected: 1 });
		await processEvent(makeEvent(), { env: baseEnv });

		expect(mockExecute).toHaveBeenCalledTimes(1);
		const call = mockExecute.mock.calls[0][0];
		expect(call.sql).toContain("INSERT INTO security_event");
		expect(call.args[0]).toBe("login.success");
		expect(call.args[1]).toBe("1.2.3.4");
	});

	it("calls ensureSchema before inserting", async () => {
		mockExecute.mockResolvedValue({ rows: [], rowsAffected: 1 });
		await processEvent(makeEvent(), { env: baseEnv });

		expect(mockEnsureSchema).toHaveBeenCalledTimes(1);
		expect(mockEnsureSchema).toHaveBeenCalledWith(baseEnv);
	});

	it("uses APP_ACTOR_ID when actorId is not provided", async () => {
		mockExecute.mockResolvedValue({ rows: [], rowsAffected: 1 });
		await processEvent(makeEvent(), { env: baseEnv });

		const args = mockExecute.mock.calls[0][0].args;
		expect(args[7]).toBe(APP_ACTOR_ID);
	});

	it("uses provided actorId when present", async () => {
		mockExecute.mockResolvedValue({ rows: [], rowsAffected: 1 });
		await processEvent(makeEvent({ actorId: "agent:bot" }), {
			env: baseEnv,
		});

		const args = mockExecute.mock.calls[0][0].args;
		expect(args[7]).toBe("agent:bot");
	});

	it("logs and continues on insert error", async () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		mockExecute.mockRejectedValue(new Error("db down"));

		await processEvent(makeEvent(), { env: baseEnv });

		expect(consoleSpy).toHaveBeenCalledWith(
			"[obs] security_event insert failed:",
			expect.any(Error),
		);
		consoleSpy.mockRestore();
	});

	it("accepts custom event types beyond well-known constants", async () => {
		mockExecute.mockResolvedValue({ rows: [], rowsAffected: 1 });
		await processEvent(makeEvent({ type: "custom.audit" }), {
			env: baseEnv,
		});

		const args = mockExecute.mock.calls[0][0].args;
		expect(args[0]).toBe("custom.audit");
	});
});
