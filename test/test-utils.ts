import { SELF } from "cloudflare:test";
import type { SqliteClient } from "../src/infrastructure/db/client.ts";

export { RESET_SQL, SCHEMA_SQL, TEST_USER_SQL } from "./sql.ts";

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
 * Authentication related test utilities
 */
export const auth = {
	/**
	 * Creates a FormData object for login requests
	 * @param {string} email - User's email address
	 * @param {string} password - User's password
	 * @returns {FormData} FormData object containing login credentials
	 */
	createLoginFormData(email: string, password: string): FormData {
		const formData = new FormData();
		formData.set("email", email);
		formData.set("password", password);
		return formData;
	},

	/**
	 * Makes an authentication request to the login endpoint
	 * @param {FormData} formData - FormData containing login credentials
	 * @returns {Promise<Response>} Response from the login request
	 */
	async makeLoginRequest(formData: FormData): Promise<Response> {
		return api.makeRequest("/api/login", {
			method: "POST",
			body: formData,
		});
	},
};

/**
 * Protected route test utilities
 */
export const api = {
	/**
	 * Makes a request to a protected API endpoint
	 * @param {string} path - API endpoint path (should start with /)
	 * @param {RequestInit} [options] - Optional fetch options
	 * @returns {Promise<Response>} Response from the API request
	 */
	async makeRequest(path: string, options?: RequestInit): Promise<Response> {
		return SELF.fetch(`${BASE_URL}${path}`, options);
	},

	/**
	 * Makes an authenticated request to a protected API endpoint
	 * @param {string} path - API endpoint path (should start with /)
	 * @param {string} token - Authentication token
	 * @param {RequestInit} [options] - Optional additional fetch options
	 * @returns {Promise<Response>} Response from the API request
	 */
	async makeAuthenticatedRequest(
		path: string,
		token: string,
		options?: RequestInit,
	): Promise<Response> {
		return this.makeRequest(path, {
			...options,
			headers: {
				...options?.headers,
				Authorization: `Bearer ${token}`,
			},
		});
	},
};
