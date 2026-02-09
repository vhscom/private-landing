/**
 * @file json-api.test.ts
 * Integration tests for JSON API responses via content negotiation.
 * Verifies that auth endpoints return structured JSON when Accept: application/json is sent,
 * while existing redirect behavior remains unchanged.
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
	loginAndGetCookies,
	makeAuthenticatedRequest,
	makeRequest,
	TEST_USER,
} from "../../fixtures/mock-env";

const JSON_HEADERS = {
	Accept: "application/json",
	"Content-Type": "application/json",
};

interface JsonSuccess {
	success: boolean;
	message: string;
}

interface JsonError {
	error: string;
	code: string;
}

function jsonBody(email: string, password: string): string {
	return JSON.stringify({ email, password });
}

let dbClient: SqliteClient;

beforeAll(async () => {
	dbClient = await initTestDb();
});

afterAll(async () => {
	await dbClient.execute(
		"DELETE FROM account WHERE email != 'test@example.com'",
	);
	await cleanupSessions(dbClient);
	dbClient.close();
});

describe("POST /api/register (JSON)", () => {
	it("returns 201 on successful registration", async () => {
		const response = await makeRequest("/api/register", {
			method: "POST",
			headers: JSON_HEADERS,
			body: jsonBody(`json-reg-${Date.now()}@example.com`, "SecurePass123!"),
		});

		expect(response.status).toBe(201);
		const data = await response.json();
		expect(data).toEqual({ success: true, message: "Account created" });
	});

	it("returns 400 for invalid email", async () => {
		const response = await makeRequest("/api/register", {
			method: "POST",
			headers: JSON_HEADERS,
			body: jsonBody("not-an-email", "SecurePass123!"),
		});

		expect(response.status).toBe(400);
		const data = (await response.json()) as JsonError;
		expect(data.error).toBeDefined();
		expect(data.code).toBe("VALIDATION_ERROR");
	});

	it("returns 400 for short password", async () => {
		const response = await makeRequest("/api/register", {
			method: "POST",
			headers: JSON_HEADERS,
			body: jsonBody("short@example.com", "short"),
		});

		expect(response.status).toBe(400);
		const data = (await response.json()) as JsonError;
		expect(data.error).toBeDefined();
		expect(data.code).toBe("VALIDATION_ERROR");
	});

	it("returns generic error for duplicate email (anti-enumeration)", async () => {
		const email = `dup-json-${Date.now()}@example.com`;

		// First registration succeeds
		const first = await makeRequest("/api/register", {
			method: "POST",
			headers: JSON_HEADERS,
			body: jsonBody(email, "SecurePass123!"),
		});
		expect(first.status).toBe(201);

		// Second registration returns same generic error — no 409 or email hint
		const second = await makeRequest("/api/register", {
			method: "POST",
			headers: JSON_HEADERS,
			body: jsonBody(email, "SecurePass123!"),
		});
		expect(second.status).toBe(400);
		const data = (await second.json()) as JsonError;
		expect(data.code).toBe("REGISTRATION_ERROR");
		expect(data.error).toBe("Registration failed");
	});

	it("still redirects without Accept: application/json", async () => {
		const formData = createCredentialsFormData(
			`redirect-${Date.now()}@example.com`,
			"SecurePass123!",
		);

		const response = await makeRequest("/api/register", {
			method: "POST",
			body: formData,
		});

		expect(response.status).toBe(200);
		expect(response.url).toContain("/?registered=true");
	});
});

describe("POST /api/login (JSON)", () => {
	it("returns 200 with cookies on successful login", async () => {
		await cleanupSessions(dbClient);

		const response = await makeRequest("/api/login", {
			method: "POST",
			headers: JSON_HEADERS,
			body: jsonBody(TEST_USER.email, TEST_USER.password),
			redirect: "manual",
		});

		expect(response.status).toBe(200);
		const data = (await response.json()) as JsonSuccess;
		expect(data).toEqual({ success: true, message: "Login successful" });

		// Cookies are still set via Set-Cookie headers
		const cookies = extractCookies(response);
		expect(cookies).toContain("access_token=");
		expect(cookies).toContain("refresh_token=");
	});

	it("returns 401 for invalid credentials", async () => {
		const response = await makeRequest("/api/login", {
			method: "POST",
			headers: JSON_HEADERS,
			body: jsonBody(TEST_USER.email, "wrongpassword"),
		});

		expect(response.status).toBe(401);
		const data = (await response.json()) as JsonError;
		expect(data.error).toBe("Authentication failed");
		expect(data.code).toBe("INVALID_CREDENTIALS");
	});

	it("returns 401 for non-existent user (anti-enumeration)", async () => {
		const response = await makeRequest("/api/login", {
			method: "POST",
			headers: JSON_HEADERS,
			body: jsonBody("nobody@example.com", "SomePassword123!"),
		});

		expect(response.status).toBe(401);
		const data = (await response.json()) as JsonError;
		expect(data.error).toBe("Authentication failed");
		expect(data.code).toBe("INVALID_CREDENTIALS");
	});

	it("still redirects without Accept: application/json", async () => {
		await cleanupSessions(dbClient);

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
});

describe("POST /api/logout (JSON)", () => {
	it("returns 200 on successful logout", async () => {
		const cookies = await loginAndGetCookies();

		const response = await makeAuthenticatedRequest("/api/logout", cookies, {
			method: "POST",
			headers: { Accept: "application/json" },
			redirect: "manual",
		});

		expect(response.status).toBe(200);
		const data = (await response.json()) as JsonSuccess;
		expect(data).toEqual({ success: true, message: "Logged out" });
	});

	it("still redirects without Accept: application/json", async () => {
		const cookies = await loginAndGetCookies();

		const response = await makeAuthenticatedRequest("/api/logout", cookies, {
			method: "POST",
		});

		expect(response.status).toBe(200);
		expect(response.url).toContain("/?logged_out=true");
	});
});
