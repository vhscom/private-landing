/**
 * @file requireAuth.test.ts
 * Integration tests for the requireAuth middleware.
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

const SUITE_EMAIL = "auth-mw-suite@example.com";

let dbClient: SqliteClient;
let suiteUserId: number;

describe("requireAuth middleware", () => {
	beforeAll(async () => {
		dbClient = await initTestDb();
		suiteUserId = await createSuiteUser(dbClient, SUITE_EMAIL);
	});

	afterAll(async () => {
		await cleanupSuiteUser(dbClient, SUITE_EMAIL);
		dbClient.close();
	});

	describe("without authentication", () => {
		it("should reject requests without any tokens", async () => {
			const response = await makeRequest("/account/me");

			expect(response.status).toBe(401);
			const data = (await response.json()) as { error: string; code: string };
			expect(data.error).toBe("Token expired");
			expect(data.code).toBe("TOKEN_EXPIRED");
		});

		it("should reject requests with malformed access token", async () => {
			const response = await makeAuthenticatedRequest(
				"/account/me",
				"access_token=not.a.valid.jwt",
			);

			expect(response.status).toBe(401);
		});

		it("should reject requests with empty cookie header", async () => {
			const response = await makeAuthenticatedRequest("/account/me", "");

			expect(response.status).toBe(401);
		});
	});

	describe("with valid authentication", () => {
		it("should allow requests with valid access token", async () => {
			const cookies = await loginAndGetCookies(
				dbClient,
				SUITE_EMAIL,
				TEST_USER.password,
			);

			const response = await makeAuthenticatedRequest("/account/me", cookies);

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data).toHaveProperty("userId");
		});

		it("should set jwtPayload in context", async () => {
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
	});

	describe("token refresh behavior", () => {
		it("should refresh access token using refresh token", async () => {
			const cookies = await loginAndGetCookies(
				dbClient,
				SUITE_EMAIL,
				TEST_USER.password,
			);

			// Extract only refresh token (simulating expired access token scenario)
			const refreshTokenOnly = cookies
				.split("; ")
				.filter((c) => c.startsWith("refresh_token="))
				.join("; ");

			const response = await makeAuthenticatedRequest(
				"/account/me",
				refreshTokenOnly,
			);

			// Middleware should use refresh token to get new access token
			expect(response.status).toBe(200);
		});

		it("should reject when both tokens are invalid", async () => {
			const response = await makeAuthenticatedRequest(
				"/account/me",
				"access_token=bad; refresh_token=also.bad",
			);

			// 401 for invalid tokens, 400 for malformed tokens
			expect([400, 401]).toContain(response.status);
		});
	});

	describe("session validation", () => {
		it("should reject revoked sessions", async () => {
			const cookies = await loginAndGetCookies(
				dbClient,
				SUITE_EMAIL,
				TEST_USER.password,
			);

			// Logout to revoke the session
			await makeAuthenticatedRequest("/auth/logout", cookies, {
				method: "POST",
			});

			// Try to use the old tokens
			const response = await makeAuthenticatedRequest("/account/me", cookies);

			// 401 Unauthorized or 403 Forbidden for revoked sessions
			expect([401, 403]).toContain(response.status);
		});
	});
});
