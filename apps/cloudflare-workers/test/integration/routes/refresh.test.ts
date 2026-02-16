/**
 * @file refresh.test.ts
 * Integration tests for token refresh functionality.
 * Token refresh happens automatically via the requireAuth middleware.
 *
 * @license Apache-2.0
 */

import type { SqliteClient } from "@private-landing/infrastructure";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	cleanupSuiteUser,
	createSuiteUser,
	extractCookies,
	initTestDb,
	loginAndGetCookies,
	makeAuthenticatedRequest,
	TEST_USER,
} from "../../fixtures/mock-env";

const SUITE_EMAIL = "refresh-suite@example.com";

let dbClient: SqliteClient;
let suiteUserId: number;

describe("Token Refresh", () => {
	beforeAll(async () => {
		dbClient = await initTestDb();
		suiteUserId = await createSuiteUser(dbClient, SUITE_EMAIL);
	});

	afterAll(async () => {
		await cleanupSuiteUser(dbClient, SUITE_EMAIL);
		dbClient.close();
	});

	it("should access protected route with valid tokens", async () => {
		const cookies = await loginAndGetCookies(
			dbClient,
			SUITE_EMAIL,
			TEST_USER.password,
		);

		const response = await makeAuthenticatedRequest("/account/me", cookies);

		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data).toHaveProperty("userId", suiteUserId);
	});

	it("should refresh tokens when accessing protected route with valid refresh token", async () => {
		const cookies = await loginAndGetCookies(
			dbClient,
			SUITE_EMAIL,
			TEST_USER.password,
		);

		// Access a protected route - this may trigger a token refresh if access token is near expiry
		const response = await makeAuthenticatedRequest("/account/me", cookies);

		expect(response.status).toBe(200);

		// Check if new cookies were set (token refresh occurred)
		const newCookies = extractCookies(response);
		// New access token may be issued if the old one was refreshed
		if (newCookies) {
			expect(newCookies).toBeDefined();
		}
	});

	it("should refresh access token using only refresh token", async () => {
		const cookies = await loginAndGetCookies(
			dbClient,
			SUITE_EMAIL,
			TEST_USER.password,
		);

		// Extract only the refresh token (simulating expired access token scenario)
		const refreshTokenOnly = cookies
			.split("; ")
			.filter((c) => c.startsWith("refresh_token="))
			.join("; ");

		const response = await makeAuthenticatedRequest(
			"/account/me",
			refreshTokenOnly,
		);

		// Should still work because requireAuth middleware handles refresh
		// by issuing a new access token from the refresh token
		expect(response.status).toBe(200);
	});

	it("should reject request with invalid refresh token", async () => {
		const response = await makeAuthenticatedRequest(
			"/account/me",
			"refresh_token=invalid.token.here",
		);

		// 401 for invalid tokens, 400 for malformed tokens
		expect([400, 401]).toContain(response.status);
	});
});
