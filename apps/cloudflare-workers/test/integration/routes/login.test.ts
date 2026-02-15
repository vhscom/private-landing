/**
 * @file login.test.ts
 * Integration tests for the /api/login endpoint.
 *
 * @license Apache-2.0
 */

import type { SqliteClient } from "@private-landing/infrastructure";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	cleanupSuiteUser,
	createCredentialsFormData,
	createSuiteUser,
	extractCookies,
	initTestDb,
	makeRequest,
	TEST_USER,
} from "../../fixtures/mock-env";

const SUITE_EMAIL = "login-suite@example.com";

let dbClient: SqliteClient;

describe("POST /api/login", () => {
	beforeAll(async () => {
		dbClient = await initTestDb();
		await createSuiteUser(dbClient, SUITE_EMAIL);
	});

	afterAll(async () => {
		await cleanupSuiteUser(dbClient, SUITE_EMAIL);
		dbClient.close();
	});

	it("should authenticate valid credentials", async () => {
		const formData = createCredentialsFormData(SUITE_EMAIL, TEST_USER.password);

		const response = await makeRequest("/api/login", {
			method: "POST",
			body: formData,
		});

		expect(response.status).toBe(200);
		expect(response.url).toContain("/?authenticated=true");
	});

	it("should set auth cookies on successful login", async () => {
		const formData = createCredentialsFormData(SUITE_EMAIL, TEST_USER.password);

		const response = await makeRequest("/api/login", {
			method: "POST",
			body: formData,
			redirect: "manual",
		});

		const cookies = extractCookies(response);
		expect(cookies).toContain("access_token=");
		expect(cookies).toContain("refresh_token=");
	});

	it("should reject invalid password", async () => {
		const formData = createCredentialsFormData(SUITE_EMAIL, "wrongpassword");

		const response = await makeRequest("/api/login", {
			method: "POST",
			body: formData,
		});

		expect(response.status).toBe(200);
		expect(response.url).toContain("error=");
	});

	it("should reject non-existent user", async () => {
		const formData = createCredentialsFormData(
			"nobody@example.com",
			"SomePassword123!",
		);

		const response = await makeRequest("/api/login", {
			method: "POST",
			body: formData,
		});

		expect(response.status).toBe(200);
		expect(response.url).toContain("error=");
	});

	it("should handle empty credentials", async () => {
		const formData = createCredentialsFormData("", "");

		const response = await makeRequest("/api/login", {
			method: "POST",
			body: formData,
		});

		expect(response.status).toBe(200);
		expect(response.url).toContain("error=");
	});

	it("should reject invalid email format", async () => {
		const formData = createCredentialsFormData("not-an-email", "Password123!");

		const response = await makeRequest("/api/login", {
			method: "POST",
			body: formData,
		});

		expect(response.status).toBe(200);
		expect(response.url).toContain("error=");
	});
});
