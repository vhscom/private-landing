/**
 * @file mock-env.ts
 * Test fixtures for environment configuration and request utilities.
 *
 * @license Apache-2.0
 */

import { env, SELF } from "cloudflare:test";
import {
	createDbClient,
	type SqliteClient,
} from "@private-landing/infrastructure";

/** Base URL for API requests in test environment */
export const BASE_URL = "http://localhost";

/** SQL to create the database schema */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS account (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_data TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES account(id),
  user_agent TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_user ON session(user_id);
CREATE INDEX IF NOT EXISTS idx_session_expiry ON session(expires_at);`;

/** SQL to insert the test user (password: Test123!@#) */
export const TEST_USER_SQL = `
INSERT OR REPLACE INTO account (id, email, password_data, created_at)
VALUES (1, 'test@example.com', '$pbkdf2-sha384$v1$100000$fW5ySXH4aQnPKYK8b7lGcA==$xE6bLhkhkXbmhMGYYInoBXOdHGZwzkpUtNdKcM0OjwSxi7oh0OfBl18OnAE4aNQe$KDLmfcH0/kcSIYmpc9vlE2LPtHCCB7ew234vojdYGfpW3H49nd3fISuDZ24uMRKr', '2025-01-20 04:10:35');`;

/**
 * Initializes the test database with schema and test user.
 * Returns the database client for cleanup in afterAll.
 */
export async function initTestDb(): Promise<SqliteClient> {
	const envName = env.ENVIRONMENT ?? "unknown";

	// SAFETY: Ensure we're using a test environment (not production)
	if (!["development", "test"].includes(envName)) {
		throw new Error(
			`initTestDb() only allowed when ENVIRONMENT is "development" or "test" (got: "${envName}")`,
		);
	}

	// SAFETY: Ensure we're using a test database (not production)
	const dbUrlLower = (env.AUTH_DB_URL ?? "").toLowerCase();
	if (!["test-db", "dev-db"].some((keyword) => dbUrlLower.includes(keyword))) {
		throw new Error(
			`AUTH_DB_URL doesn't look like a test/dev db: ${env.AUTH_DB_URL}`,
		);
	}

	const dbClient = createDbClient(env);

	// Create schema
	for (const stmt of SCHEMA_SQL.split(";").filter((s) => s.trim())) {
		await dbClient.execute(stmt.trim());
	}

	// Insert test user
	await dbClient.execute(TEST_USER_SQL);

	return dbClient;
}

/**
 * Cleans up sessions from the database
 */
export async function cleanupSessions(dbClient: SqliteClient): Promise<void> {
	await dbClient.execute("DELETE FROM session");
}

/**
 * Test user credentials for authentication tests.
 * Password hash corresponds to "Test123!@#"
 */
export const TEST_USER = {
	email: "test@example.com",
	password: "Test123!@#",
} as const;

/**
 * Creates a FormData object for credential-based requests
 */
export function createCredentialsFormData(
	email: string,
	password: string,
): FormData {
	const formData = new FormData();
	formData.set("email", email);
	formData.set("password", password);
	return formData;
}

/**
 * Makes a request to an API endpoint via the Worker
 */
export async function makeRequest(
	path: string,
	options?: RequestInit,
): Promise<Response> {
	return SELF.fetch(`${BASE_URL}${path}`, options);
}

/**
 * Makes an authenticated request with cookies from a previous response
 */
export async function makeAuthenticatedRequest(
	path: string,
	cookies: string,
	options?: RequestInit,
): Promise<Response> {
	return makeRequest(path, {
		...options,
		headers: {
			...options?.headers,
			Cookie: cookies,
		},
	});
}

/**
 * Extracts Set-Cookie headers from a response.
 * Uses getSetCookie() which correctly handles multiple Set-Cookie headers.
 */
export function extractCookies(response: Response): string {
	// getSetCookie() returns an array of all Set-Cookie header values
	const setCookieHeaders = response.headers.getSetCookie();
	const cookies = setCookieHeaders.map((header) => {
		// Extract just the cookie name=value part (before any attributes)
		return header.split(";")[0];
	});
	return cookies.join("; ");
}

/**
 * Performs a login and returns the authentication cookies.
 * Cleans up existing sessions first to avoid hitting the max sessions limit.
 */
export async function loginAndGetCookies(
	email = TEST_USER.email,
	password = TEST_USER.password,
): Promise<string> {
	// Clean up existing sessions to avoid hitting max sessions limit
	const dbClient = createDbClient(env);
	await dbClient.execute("DELETE FROM session WHERE user_id = 1");
	dbClient.close();

	const formData = createCredentialsFormData(email, password);
	const response = await makeRequest("/api/login", {
		method: "POST",
		body: formData,
		redirect: "manual",
	});
	return extractCookies(response);
}
