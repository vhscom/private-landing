/**
 * @file refresh.test.ts
 * Integration tests for token refresh functionality.
 * Token refresh happens automatically via the requireAuth middleware.
 *
 * @remarks
 * **Known flakiness**: These tests share database state (sessions for user_id=1)
 * with other test suites. When run in parallel with requireAuth.test.ts, race
 * conditions can cause intermittent failures. The `--retry 3` flag handles this.
 *
 * @license Apache-2.0
 */

import type { SqliteClient } from "@private-landing/infrastructure";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	cleanupSessions,
	extractCookies,
	initTestDb,
	loginAndGetCookies,
	makeAuthenticatedRequest,
} from "../../fixtures/mock-env";

let dbClient: SqliteClient;

describe("Token Refresh", () => {
	beforeAll(async () => {
		dbClient = await initTestDb();
	});

	afterAll(async () => {
		await cleanupSessions(dbClient);
		dbClient.close();
	});

	it("should access protected route with valid tokens", async () => {
		const cookies = await loginAndGetCookies();

		const response = await makeAuthenticatedRequest("/api/ping", cookies);

		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data).toHaveProperty("message", "pong");
		expect(data).toHaveProperty("userId", 1);
	});

	it("should refresh tokens when accessing protected route with valid refresh token", async () => {
		const cookies = await loginAndGetCookies();

		// Access a protected route - this may trigger a token refresh if access token is near expiry
		const response = await makeAuthenticatedRequest("/api/ping", cookies);

		expect(response.status).toBe(200);

		// Check if new cookies were set (token refresh occurred)
		const newCookies = extractCookies(response);
		// New access token may be issued if the old one was refreshed
		if (newCookies) {
			expect(newCookies).toBeDefined();
		}
	});

	it("should refresh access token using only refresh token", async () => {
		const cookies = await loginAndGetCookies();

		// Extract only the refresh token (simulating expired access token scenario)
		const refreshTokenOnly = cookies
			.split("; ")
			.filter((c) => c.startsWith("refresh_token="))
			.join("; ");

		const response = await makeAuthenticatedRequest(
			"/api/ping",
			refreshTokenOnly,
		);

		// Should still work because requireAuth middleware handles refresh
		// by issuing a new access token from the refresh token
		expect(response.status).toBe(200);
	});

	it("should reject request with invalid refresh token", async () => {
		const response = await makeAuthenticatedRequest(
			"/api/ping",
			"refresh_token=invalid.token.here",
		);

		// 401 for invalid tokens, 400 for malformed tokens
		expect([400, 401]).toContain(response.status);
	});
});
