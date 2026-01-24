/**
 * @file login.test.ts
 * Integration tests for the /api/login endpoint.
 *
 * @license Apache-2.0
 */

import type { SqliteClient } from "@private-landing/infrastructure";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	cleanupSessions,
	createCredentialsFormData,
	extractCookies,
	initTestDb,
	makeRequest,
	TEST_USER,
} from "../../fixtures/mock-env";

let dbClient: SqliteClient;

describe("POST /api/login", () => {
	beforeAll(async () => {
		dbClient = await initTestDb();
	});

	afterAll(async () => {
		await cleanupSessions(dbClient);
		dbClient.close();
	});

	it("should authenticate valid credentials", async () => {
		const formData = createCredentialsFormData(
			TEST_USER.email,
			TEST_USER.password,
		);

		const response = await makeRequest("/api/login", {
			method: "POST",
			body: formData,
		});

		expect(response.status).toBe(200);
		expect(response.url).toContain("/?authenticated=true");
	});

	it("should set auth cookies on successful login", async () => {
		const formData = createCredentialsFormData(
			TEST_USER.email,
			TEST_USER.password,
		);

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
		const formData = createCredentialsFormData(
			TEST_USER.email,
			"wrongpassword",
		);

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
