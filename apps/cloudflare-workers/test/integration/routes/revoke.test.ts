/**
 * @file revoke.test.ts
 * Integration tests for the /auth/logout endpoint (session revocation).
 *
 * @license Apache-2.0
 */

import type { SqliteClient } from "@private-landing/infrastructure";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	cleanupSuiteUser,
	createSuiteUser,
	initTestDb,
	loginAndGetCookies,
	makeAuthenticatedRequest,
	makeRequest,
	TEST_USER,
} from "../../fixtures/mock-env";

const SUITE_EMAIL = "revoke-suite@example.com";

let dbClient: SqliteClient;

describe("POST /auth/logout", () => {
	beforeAll(async () => {
		dbClient = await initTestDb();
		await createSuiteUser(dbClient, SUITE_EMAIL);
	});

	afterAll(async () => {
		await cleanupSuiteUser(dbClient, SUITE_EMAIL);
		dbClient.close();
	});

	it("should logout authenticated user", async () => {
		const cookies = await loginAndGetCookies(
			dbClient,
			SUITE_EMAIL,
			TEST_USER.password,
		);

		const response = await makeAuthenticatedRequest("/auth/logout", cookies, {
			method: "POST",
		});

		expect(response.status).toBe(200);
		expect(response.url).toMatch(/\/$/);
	}, 10_000);

	it("should invalidate session after logout", async () => {
		const cookies = await loginAndGetCookies(
			dbClient,
			SUITE_EMAIL,
			TEST_USER.password,
		);

		// Logout
		await makeAuthenticatedRequest("/auth/logout", cookies, {
			method: "POST",
		});

		// Try to access protected route with the same cookies
		const response = await makeAuthenticatedRequest("/account/me", cookies);

		// Should be rejected because session was revoked (401 or 403)
		expect([401, 403]).toContain(response.status);
	});

	it("should reject logout without authentication", async () => {
		const response = await makeRequest("/auth/logout", {
			method: "POST",
		});

		expect(response.status).toBe(401);
	});

	it("should reject logout with invalid token", async () => {
		const response = await makeAuthenticatedRequest(
			"/auth/logout",
			"access_token=invalid.token.here",
			{ method: "POST" },
		);

		expect(response.status).toBe(401);
	});
});
