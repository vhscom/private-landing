/**
 * @file password-change.test.ts
 * Integration tests for the POST /api/account/password endpoint.
 *
 * @license Apache-2.0
 */

import type { SqliteClient } from "@private-landing/infrastructure";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	cleanupSuiteUser,
	createSuiteUser,
	initTestDb,
	loginAndGetCookies,
	makeAuthenticatedRequest,
	makeRequest,
	TEST_USER,
} from "../../fixtures/mock-env";

const SUITE_EMAIL = "password-change-suite@example.com";

const JSON_HEADERS = {
	Accept: "application/json",
	"Content-Type": "application/json",
};

let dbClient: SqliteClient;

/**
 * Re-creates the suite user with the original password hash so that
 * subsequent tests start from a known state.
 */
async function resetSuiteUserPassword(): Promise<void> {
	await cleanupSuiteUser(dbClient, SUITE_EMAIL);
	await createSuiteUser(dbClient, SUITE_EMAIL);
}

describe("POST /api/account/password", () => {
	beforeAll(async () => {
		dbClient = await initTestDb();
	});

	beforeEach(async () => {
		await resetSuiteUserPassword();
	});

	afterAll(async () => {
		await cleanupSuiteUser(dbClient, SUITE_EMAIL);
		dbClient.close();
	});

	it("should change password successfully (JSON)", async () => {
		const cookies = await loginAndGetCookies(
			dbClient,
			SUITE_EMAIL,
			TEST_USER.password,
		);

		const response = await makeAuthenticatedRequest(
			"/api/account/password",
			cookies,
			{
				method: "POST",
				headers: JSON_HEADERS,
				body: JSON.stringify({
					currentPassword: TEST_USER.password,
					newPassword: "NewSecurePass1!",
				}),
				redirect: "manual",
			},
		);

		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data).toEqual({
			success: true,
			message: "Password changed successfully",
		});
	}, 15_000);

	it("should invalidate all sessions after change", async () => {
		const cookies = await loginAndGetCookies(
			dbClient,
			SUITE_EMAIL,
			TEST_USER.password,
		);

		// Change password
		await makeAuthenticatedRequest("/api/account/password", cookies, {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({
				currentPassword: TEST_USER.password,
				newPassword: "AnotherPass123!",
			}),
			redirect: "manual",
		});

		// Old cookies should no longer work
		const pingResponse = await makeAuthenticatedRequest("/api/ping", cookies, {
			headers: { Accept: "application/json" },
		});

		// 403: the JWT is still valid but the session has been revoked
		expect(pingResponse.status).toBe(403);
	}, 15_000);

	it("should allow login with new password", async () => {
		const cookies = await loginAndGetCookies(
			dbClient,
			SUITE_EMAIL,
			TEST_USER.password,
		);

		const newPassword = "FreshPassword99!";

		// Change password
		await makeAuthenticatedRequest("/api/account/password", cookies, {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({
				currentPassword: TEST_USER.password,
				newPassword,
			}),
			redirect: "manual",
		});

		// Login with new password
		const newCookies = await loginAndGetCookies(
			dbClient,
			SUITE_EMAIL,
			newPassword,
		);

		const pingResponse = await makeAuthenticatedRequest(
			"/api/ping",
			newCookies,
			{
				headers: { Accept: "application/json" },
			},
		);

		expect(pingResponse.status).toBe(200);
	}, 15_000);

	it("should reject incorrect current password", async () => {
		const cookies = await loginAndGetCookies(
			dbClient,
			SUITE_EMAIL,
			TEST_USER.password,
		);

		const response = await makeAuthenticatedRequest(
			"/api/account/password",
			cookies,
			{
				method: "POST",
				headers: JSON_HEADERS,
				body: JSON.stringify({
					currentPassword: "WrongPassword1!",
					newPassword: "NewPassword456!",
				}),
				redirect: "manual",
			},
		);

		expect(response.status).toBe(400);
	}, 15_000);

	it("should reject same new/current password", async () => {
		const cookies = await loginAndGetCookies(
			dbClient,
			SUITE_EMAIL,
			TEST_USER.password,
		);

		const response = await makeAuthenticatedRequest(
			"/api/account/password",
			cookies,
			{
				method: "POST",
				headers: JSON_HEADERS,
				body: JSON.stringify({
					currentPassword: TEST_USER.password,
					newPassword: TEST_USER.password,
				}),
				redirect: "manual",
			},
		);

		expect(response.status).toBe(400);
	}, 15_000);

	it("should require authentication (no cookies -> 401)", async () => {
		const response = await makeRequest("/api/account/password", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({
				currentPassword: TEST_USER.password,
				newPassword: "NewPassword456!",
			}),
		});

		expect(response.status).toBe(401);
	});

	it("should return JSON when Accept: application/json", async () => {
		const cookies = await loginAndGetCookies(
			dbClient,
			SUITE_EMAIL,
			TEST_USER.password,
		);

		const response = await makeAuthenticatedRequest(
			"/api/account/password",
			cookies,
			{
				method: "POST",
				headers: JSON_HEADERS,
				body: JSON.stringify({
					currentPassword: TEST_USER.password,
					newPassword: "JsonTestPass1!",
				}),
				redirect: "manual",
			},
		);

		expect(response.status).toBe(200);
		const contentType = response.headers.get("content-type");
		expect(contentType).toContain("application/json");
	}, 15_000);

	it("should redirect without Accept: application/json", async () => {
		const cookies = await loginAndGetCookies(
			dbClient,
			SUITE_EMAIL,
			TEST_USER.password,
		);

		const formData = new FormData();
		formData.set("currentPassword", TEST_USER.password);
		formData.set("newPassword", "RedirectTestP1!");

		const response = await makeAuthenticatedRequest(
			"/api/account/password",
			cookies,
			{
				method: "POST",
				body: formData,
			},
		);

		expect(response.status).toBe(200);
		expect(response.url).toContain("/?password_changed=true");
	}, 15_000);
});
