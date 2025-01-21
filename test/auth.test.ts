import { env } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type SqliteClient,
	createDbClient,
} from "../src/infrastructure/db/client.ts";
import {
	RESET_SQL,
	TEST_USER,
	createLoginFormData,
	makeRequest,
} from "./test-utils.ts";
import { executeSQL, initTestDB, makeLoginRequest } from "./test-utils.ts";

let dbClient: SqliteClient;

describe("Login", () => {
	beforeAll(async () => {
		dbClient = createDbClient(env);
		await initTestDB(dbClient, env);
	});

	afterAll(async () => {
		await executeSQL(RESET_SQL, dbClient);
		dbClient.close();
	});

	it("Should authenticate valid credentials", async () => {
		const formData = createLoginFormData(TEST_USER.email, TEST_USER.password);
		const response = await makeRequest("/api/login", {
			method: "POST",
			body: formData,
		});
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
	it("should reject requests without token", async () => {
		const response = await makeRequest("/api/ping");
		const data = (await response.json()) as { error: string };
		expect(response.status).toBe(401);
		expect(data.error).toBe("Authentication required");
	});

	it("should handle malformed tokens", async () => {
		const response = await makeRequest("/api/ping", {
			headers: {
				Authorization: "Bearer invalid_token",
			},
		});
		expect(response.status).toBe(401);
	});
});
