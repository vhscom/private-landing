/**
 * @file adaptive-flow.test.ts
 * End-to-end adaptive challenge escalation: threshold → low difficulty → high difficulty → PoW solve.
 *
 * @license Apache-2.0
 */

import type { Env } from "@private-landing/types";
import { describe, expect, it, vi } from "vitest";
import { adaptiveDefaults } from "../src/config";

const mockExecute = vi.fn();

vi.mock("@private-landing/infrastructure", () => ({
	createDbClient: vi.fn(() => ({ execute: mockExecute })),
}));

vi.mock("../src/schema", () => ({
	ensureSchema: vi.fn(),
}));

import { computeChallenge } from "../src/process-event";

const env: Env = {
	AUTH_DB_URL: "libsql://test.turso.io",
	AUTH_DB_TOKEN: "test-token",
	JWT_ACCESS_SECRET: "test",
	JWT_REFRESH_SECRET: "test",
};

/** Simulate N login failures in the DB. */
function mockFailureCount(n: number) {
	mockExecute.mockResolvedValueOnce({ rows: [{ count: n }] });
}

/** Solve a PoW challenge: find i where SHA-256(nonce + i) starts with `difficulty` hex zeros. */
async function solve(
	nonce: string,
	difficulty: number,
): Promise<{ solution: string; hash: string }> {
	const prefix = "0".repeat(difficulty);
	for (let i = 0; ; i++) {
		const data = new TextEncoder().encode(nonce + i);
		const buf = await crypto.subtle.digest("SHA-256", data);
		const hash = [...new Uint8Array(buf)]
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		if (hash.startsWith(prefix)) return { solution: String(i), hash };
	}
}

describe("adaptive challenge escalation", () => {
	it("returns null below failure threshold", async () => {
		mockFailureCount(2);
		const result = await computeChallenge("1.2.3.4", env);
		expect(result).toBeNull();
	});

	it("returns low difficulty at failure threshold", async () => {
		mockFailureCount(adaptiveDefaults.failureThreshold);
		const result = await computeChallenge("1.2.3.4", env);
		if (result == null) return expect.unreachable("expected challenge");
		expect(result.type).toBe("pow");
		expect(result.difficulty).toBe(adaptiveDefaults.lowDifficulty);
		expect(result.nonce).toMatch(/^[0-9a-f]{32}$/);
	});

	it("returns high difficulty at high threshold", async () => {
		mockFailureCount(adaptiveDefaults.highThreshold);
		const result = await computeChallenge("1.2.3.4", env);
		if (result == null) return expect.unreachable("expected challenge");
		expect(result.difficulty).toBe(adaptiveDefaults.highDifficulty);
	});

	it("escalates through full flow: none → low → high", async () => {
		// Below threshold
		mockFailureCount(0);
		expect(await computeChallenge("1.2.3.4", env)).toBeNull();

		// At threshold — low difficulty
		mockFailureCount(3);
		const low = await computeChallenge("1.2.3.4", env);
		if (low == null) return expect.unreachable("expected low challenge");
		expect(low.difficulty).toBe(3);

		// At high threshold — high difficulty
		mockFailureCount(6);
		const high = await computeChallenge("1.2.3.4", env);
		if (high == null) return expect.unreachable("expected high challenge");
		expect(high.difficulty).toBe(5);
	});

	it("PoW solution verifies: SHA-256(nonce + solution) has leading zeros", async () => {
		mockFailureCount(3);
		const challenge = await computeChallenge("1.2.3.4", env);
		if (challenge == null) return expect.unreachable("expected challenge");

		const { solution, hash } = await solve(
			challenge.nonce,
			challenge.difficulty,
		);
		const prefix = "0".repeat(challenge.difficulty);
		expect(hash.startsWith(prefix)).toBe(true);
		expect(Number(solution)).toBeGreaterThanOrEqual(0);
	});

	it("accepts custom thresholds", async () => {
		const custom = {
			...adaptiveDefaults,
			failureThreshold: 1,
			lowDifficulty: 2,
		};
		mockFailureCount(1);
		const result = await computeChallenge("1.2.3.4", env, custom);
		if (result == null) return expect.unreachable("expected challenge");
		expect(result.difficulty).toBe(2);
	});

	it("queries custom eventType when provided", async () => {
		mockFailureCount(adaptiveDefaults.failureThreshold);
		const result = await computeChallenge(
			"1.2.3.4",
			env,
			adaptiveDefaults,
			"registration.failure",
		);
		if (result == null) return expect.unreachable("expected challenge");
		expect(result.type).toBe("pow");
		expect(result.difficulty).toBe(adaptiveDefaults.lowDifficulty);

		// Verify the SQL query used the custom event type
		const lastCall = mockExecute.mock.calls.at(-1);
		expect(lastCall?.[0].args).toContain("registration.failure");
	});

	it("fail-opens on DB error", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		mockExecute.mockRejectedValueOnce(new Error("db down"));
		const result = await computeChallenge("1.2.3.4", env);
		expect(result).toBeNull();
		spy.mockRestore();
	});
});
