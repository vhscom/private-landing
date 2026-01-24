/**
 * @file signup.test.ts
 * Integration tests for the /api/register endpoint.
 *
 * @license Apache-2.0
 */

import type { SqliteClient } from "@private-landing/infrastructure";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createCredentialsFormData,
	initTestDb,
	makeRequest,
} from "../../fixtures/mock-env";

let dbClient: SqliteClient;

describe("POST /api/register", () => {
	beforeAll(async () => {
		dbClient = await initTestDb();
	});

	afterAll(async () => {
		// Clean up test accounts (keep the seeded test user)
		await dbClient.execute(
			"DELETE FROM account WHERE email != 'test@example.com'",
		);
		await dbClient.execute("DELETE FROM session");
		dbClient.close();
	});

	it("should register a new user with valid credentials", async () => {
		const formData = createCredentialsFormData(
			"newuser@example.com",
			"SecurePassword123!",
		);

		const response = await makeRequest("/api/register", {
			method: "POST",
			body: formData,
		});

		expect(response.status).toBe(200);
		expect(response.url).toContain("/?registered=true");
	});

	it("should reject registration with invalid email", async () => {
		const formData = createCredentialsFormData(
			"not-an-email",
			"SecurePassword123!",
		);

		const response = await makeRequest("/api/register", {
			method: "POST",
			body: formData,
		});

		expect(response.status).toBe(200);
		expect(response.url).toContain("error=");
	});

	it("should reject registration with short password", async () => {
		const formData = createCredentialsFormData("short@example.com", "short");

		const response = await makeRequest("/api/register", {
			method: "POST",
			body: formData,
		});

		expect(response.status).toBe(200);
		expect(response.url).toContain("error=");
	});

	it("should reject duplicate email registration", async () => {
		// Use unique email to avoid conflicts with other test runs
		const uniqueEmail = `duplicate-${Date.now()}@example.com`;
		const formData = createCredentialsFormData(
			uniqueEmail,
			"SecurePassword123!",
		);

		// First registration should succeed
		const firstResponse = await makeRequest("/api/register", {
			method: "POST",
			body: formData,
		});
		expect(firstResponse.url).toContain("/?registered=true");

		// Second registration with same email should fail
		const secondResponse = await makeRequest("/api/register", {
			method: "POST",
			body: formData,
		});
		expect(secondResponse.url).toContain("error=");
	});

	it("should handle empty form data", async () => {
		const formData = createCredentialsFormData("", "");

		const response = await makeRequest("/api/register", {
			method: "POST",
			body: formData,
		});

		expect(response.status).toBe(200);
		expect(response.url).toContain("error=");
	});
});
