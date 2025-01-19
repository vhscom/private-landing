import { describe, expect, it } from "vitest";
import { api, auth } from "./test-utils.ts";

const TEST_USER = {
	email: "test@example.com",
	password: "Test123!@#",
} as const;

describe("Login", () => {
	// Enable once database is seeded with test data
	it.skip("Should successfully authenticate valid credentials", async () => {
		const formData = auth.createLoginFormData(
			TEST_USER.email,
			TEST_USER.password,
		);
		const response = await api.makeRequest("/api/login", {
			method: "POST",
			body: formData,
		});
		expect(response.status).toBe(200);
		expect(response.url).toContain("/?authenticated=true");
	});

	it("Should reject invalid credentials", async () => {
		const formData = auth.createLoginFormData(TEST_USER.email, "wrongpassword");
		const response = await auth.makeLoginRequest(formData);
		expect(response.status).toBe(200);
		expect(response.url).toContain("error=");
	});

	it("Should handle empty credentials", async () => {
		const formData = auth.createLoginFormData("", "");
		const response = await auth.makeLoginRequest(formData);

		expect(response.status).toBe(200);
		expect(response.url).toContain("error=");
	});
});

describe("Protected Routes", () => {
	it("should reject requests without token", async () => {
		const response = await api.makeRequest("/api/ping");
		const data = (await response.json()) as { error: string };

		expect(response.status).toBe(401);
		expect(data.error).toBe("Authentication required");
	});

	it("should handle malformed tokens", async () => {
		const response = await api.makeRequest("/api/ping", {
			headers: {
				Authorization: "Bearer invalid_token",
			},
		});

		expect(response.status).toBe(401);
	});
});
