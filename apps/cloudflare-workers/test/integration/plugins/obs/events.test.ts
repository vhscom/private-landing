/**
 * @file events.test.ts
 * Integration tests for observability plugin event emission.
 * Plugin-only — delete this directory when removing packages/observability.
 *
 * @license Apache-2.0
 */

import type { SqliteClient } from "@private-landing/infrastructure";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	cleanupSecurityEvents,
	cleanupSuiteUser,
	createCredentialsFormData,
	createSuiteUser,
	initTestDb,
	loginAndGetCookies,
	makeAuthenticatedRequest,
	makeRequest,
	TEST_USER,
} from "../../../fixtures/mock-env";

const SUITE_EMAIL = "obs-events-suite@example.com";

let dbClient: SqliteClient;

/** Poll security_event for a specific event type, retrying for async writes. */
async function pollForEvent(type: string, maxAttempts = 10): Promise<boolean> {
	for (let i = 0; i < maxAttempts; i++) {
		const result = await dbClient.execute({
			sql: "SELECT type FROM security_event WHERE type = ?",
			args: [type],
		});
		if (result.rows.length > 0) return true;
		await new Promise((r) => setTimeout(r, 200));
	}
	return false;
}

describe("[obs-plugin] event emission", () => {
	beforeAll(async () => {
		dbClient = await initTestDb();
		await createSuiteUser(dbClient, SUITE_EMAIL);
	});

	afterAll(async () => {
		await cleanupSecurityEvents(dbClient);
		await cleanupSuiteUser(dbClient, SUITE_EMAIL);
		await dbClient.execute(
			"DELETE FROM account WHERE email LIKE 'obs-reg-%@example.com'",
		);
		dbClient.close();
	});

	it("stores registration.success event after successful registration", async () => {
		await cleanupSecurityEvents(dbClient);

		const formData = createCredentialsFormData(
			`obs-reg-success-${Date.now()}@example.com`,
			"SecurePassword123!",
		);
		await makeRequest("/auth/register", {
			method: "POST",
			body: formData,
			headers: { Accept: "application/json" },
		});

		expect(await pollForEvent("registration.success")).toBe(true);
	});

	it("stores registration.failure event after failed registration", async () => {
		await cleanupSecurityEvents(dbClient);

		const formData = createCredentialsFormData("not-an-email", "short");
		await makeRequest("/auth/register", {
			method: "POST",
			body: formData,
			headers: { Accept: "application/json" },
		});

		expect(await pollForEvent("registration.failure")).toBe(true);
	});

	it("stores login.failure event after failed login", async () => {
		await cleanupSecurityEvents(dbClient);

		const formData = createCredentialsFormData(SUITE_EMAIL, "wrong-password");
		await makeRequest("/auth/login", {
			method: "POST",
			body: formData,
			headers: { Accept: "application/json" },
		});

		// obsEmitEvent fires via waitUntil — poll for the async write
		expect(await pollForEvent("login.failure")).toBe(true);
	});

	it("stores login.success event after successful login", async () => {
		await cleanupSecurityEvents(dbClient);

		const formData = createCredentialsFormData(SUITE_EMAIL, TEST_USER.password);
		await makeRequest("/auth/login", {
			method: "POST",
			body: formData,
			headers: { Accept: "application/json" },
		});

		// obsEmitEvent fires via waitUntil — poll for the async write
		expect(await pollForEvent("login.success")).toBe(true);
	});

	it("stores session.revoke event after logout", async () => {
		await cleanupSecurityEvents(dbClient);

		const cookies = await loginAndGetCookies(dbClient, SUITE_EMAIL);
		await cleanupSecurityEvents(dbClient);

		await makeAuthenticatedRequest("/auth/logout", cookies, {
			method: "POST",
			headers: { Accept: "application/json" },
		});

		expect(await pollForEvent("session.revoke")).toBe(true);
	}, 15_000);

	it("stores password.change event after password change", async () => {
		await cleanupSecurityEvents(dbClient);

		const cookies = await loginAndGetCookies(dbClient, SUITE_EMAIL);
		await cleanupSecurityEvents(dbClient);

		await makeAuthenticatedRequest("/account/password", cookies, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				currentPassword: TEST_USER.password,
				newPassword: "NewTest456!@#",
			}),
		});

		expect(await pollForEvent("password.change")).toBe(true);
	}, 15_000);
});
