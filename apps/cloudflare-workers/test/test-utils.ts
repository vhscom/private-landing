/**
 * @file test-utils.ts
 * Testing utilities for authentication and API request simulation.
 *
 * @license Apache-2.0
 */

import { SELF } from "cloudflare:test";

export { RESET_SQL, SCHEMA_SQL, TEST_USER_SQL } from "./sql";
export { initTestDB, executeSQL } from "./db-setup";

/** Base URL for API requests in test environment */
export const BASE_URL = "http://localhost";

/**
 * Test user credentials for authentication tests
 */
export const TEST_USER = {
	email: "test@example.com",
	password: "Test123!@#",
} as const;

/**
 * Creates a FormData object for login requests
 * @param {string} email - User's email address
 * @param {string} password - User's password
 * @returns {FormData} FormData object containing login credentials
 */
export function createLoginFormData(email: string, password: string): FormData {
	const formData = new FormData();
	formData.set("email", email);
	formData.set("password", password);
	return formData;
}

/**
 * Makes an authentication request to the login endpoint
 * @param {FormData} formData - FormData containing login credentials
 * @returns {Promise<Response>} Response from the login request
 */
export async function makeLoginRequest(formData: FormData): Promise<Response> {
	return makeRequest("/api/login", {
		method: "POST",
		body: formData,
	});
}

/**
 * Makes a request to a protected API endpoint
 * @param {string} path - API endpoint path (should start with /)
 * @param {RequestInit} [options] - Optional fetch options
 * @returns {Promise<Response>} Response from the API request
 */
export async function makeRequest(
	path: string,
	options?: RequestInit,
): Promise<Response> {
	return SELF.fetch(`${BASE_URL}${path}`, options);
}

/**
 * Makes an authenticated request to a protected API endpoint
 * @param {string} path - API endpoint path (should start with /)
 * @param {string} token - Authentication token
 * @param {RequestInit} [options] - Optional additional fetch options
 * @returns {Promise<Response>} Response from the API request
 */
export async function makeAuthenticatedRequest(
	path: string,
	token: string,
	options?: RequestInit,
): Promise<Response> {
	return makeRequest(path, {
		...options,
		headers: {
			...options?.headers,
			Authorization: `Bearer ${token}`,
		},
	});
}
