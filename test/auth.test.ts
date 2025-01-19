import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/app";

describe("Security Headers", () => {
	it("Should follow OWASP secure headers guidance", async () => {
		const { headers } = await app.request("/index.html", {}, env);

		expect(headers.get("Strict-Transport-Security")).toBe(
			"max-age=31536000; includeSubDomains",
		);
		expect(headers.get("X-Frame-Options")).toBe("deny");
		expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(headers.get("X-Permitted-Cross-Domain-Policies")).toBe("none");
		expect(headers.get("Referrer-Policy")).toBe("no-referrer");
		expect(headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
		expect(headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
		expect(headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");

		expect(headers.get("Server")).toBeNull();
		expect(headers.get("X-Powered-By")).toBeNull();

		const csp = headers.get("Content-Security-Policy");
		expect(csp).toBeDefined();
		expect(csp).toContain("default-src 'self'");

		const permissionsPolicy = headers.get("Permissions-Policy");
		expect(permissionsPolicy).not.toBeNull();
	});
});

const BASE_PATH = "https://example.com";
const TEST_USER = {
	email: "test@example.com",
	password: "Test123!@#",
} as const;

describe("Login", () => {
	const createLoginFormData = (email: string, password: string) => {
		const formData = new FormData();
		formData.set("email", email);
		formData.set("password", password);
		return formData;
	};

	const makeLoginRequest = async (formData: FormData) => {
		return SELF.fetch(`${BASE_PATH}/api/login`, {
			method: "POST",
			body: formData,
		});
	};

	// Enable once database is seeded with test data
	it.skip("Should successfully authenticate valid credentials", async () => {
		const formData = createLoginFormData(TEST_USER.email, TEST_USER.password);
		const response = await makeLoginRequest(formData);

		expect(response.status).toBe(200);
		expect(response.url).toContain("/?authenticated=true");
	});

	it("Should reject invalid credentials", async () => {
		const formData = createLoginFormData(TEST_USER.email, "wrongpassword");
		const response = await makeLoginRequest(formData);
		expect(response.status).toBe(200);
		expect(response.url).toContain("error=");
	});

	it("Should handle empty credentials", async () => {
		const formData = createLoginFormData("", "");
		const response = await makeLoginRequest(formData);

		expect(response.status).toBe(200);
		expect(response.url).toContain("error=");
	});
});

describe("Protected Routes", () => {
	const makeProtectedRequest = (path: string) =>
		SELF.fetch(`${BASE_PATH}${path}`);

	it("Should reject requests without token", async () => {
		const response = await makeProtectedRequest("/api/ping");
		const data = (await response.json()) as { error: string };

		expect(response.status).toBe(401);
		expect(data.error).toBe("Authentication required");
	});

	it("Should handle malformed tokens", async () => {
		const response = await SELF.fetch(`${BASE_PATH}/api/ping`, {
			headers: {
				Authorization: "Bearer invalid_token",
			},
		});

		expect(response.status).toBe(401);
	});
});

describe("Static Asset Serving", () => {
	it("Should serve static files with correct content type", async () => {
		const res = await app.request("/index.html", {}, env);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
	});

	it("Should properly handle non-existent static files", async () => {
		const res = await app.request("/non-existent.jpg", {}, env);
		expect(res.status).toBe(404);
	});
});
