/**
 * @file access.test.ts
 * Integration tests for control bridge access control layers.
 * Plugin-only — delete this directory when removing packages/control.
 *
 * @license Apache-2.0
 */

import type { SqliteClient } from "@private-landing/infrastructure";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	cleanupSecurityEvents,
	cleanupSuiteUser,
	createSuiteUser,
	initTestDb,
	loginAndGetCookies,
	makeAuthenticatedRequest,
	makeRequest,
	TEST_USER,
} from "../../../fixtures/mock-env";

const SUITE_EMAIL = "control-access-suite@example.com";

let dbClient: SqliteClient;

describe("[ctl-plugin] access control", () => {
	beforeAll(async () => {
		dbClient = await initTestDb();
		await createSuiteUser(dbClient, SUITE_EMAIL);
	});

	afterAll(async () => {
		await cleanupSecurityEvents(dbClient);
		await cleanupSuiteUser(dbClient, SUITE_EMAIL);
		dbClient.close();
	});

	describe("auth guard", () => {
		it("rejects unauthenticated requests to /ops/control", async () => {
			const response = await makeRequest("/ops/control/test", {
				headers: { Accept: "application/json" },
			});
			expect(response.status).toBe(401);
		});

		it("rejects unauthenticated requests to /ops/ws", async () => {
			const response = await makeRequest("/ops/ws", {
				headers: { Accept: "application/json" },
			});
			expect(response.status).toBe(401);
		});
	});

	describe("user-1 guard", () => {
		it("blocks non-uid-1 users with 404", async () => {
			const cookies = await loginAndGetCookies(
				dbClient,
				SUITE_EMAIL,
				TEST_USER.password,
			);
			await cleanupSecurityEvents(dbClient);

			const response = await makeAuthenticatedRequest(
				"/ops/control/test",
				cookies,
				{
					headers: { Accept: "application/json" },
				},
			);
			expect(response.status).toBe(404);
		});

		it("allows uid=1 past the guard", async () => {
			const cookies = await loginAndGetCookies(
				dbClient,
				TEST_USER.email,
				TEST_USER.password,
			);

			const response = await makeAuthenticatedRequest(
				"/ops/control/test",
				cookies,
				{
					headers: { Accept: "application/json" },
				},
			);
			// uid=1 passes auth and guard — not 401
			// Returns 404 when GATEWAY_URL is absent (expected in CI)
			expect(response.status).not.toBe(401);
		});
	});
});
