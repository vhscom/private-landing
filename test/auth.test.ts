import { env } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type SqliteClient,
	createDbClient,
} from "../src/infrastructure/db/client.ts";
import {
	RESET_SQL,
	SCHEMA_SQL,
	TEST_USER,
	TEST_USER_SQL,
	api,
	auth,
} from "./test-utils.ts";

let dbClient: SqliteClient;

const executeSQL = async (sql: string, client: SqliteClient) => {
	const statements = sql
		.split(";")
		.map((statement) => statement.trim())
		.filter(Boolean);

	for (const statement of statements) {
		await client.execute(statement);
	}
};

describe("Login", () => {
	beforeAll(async () => {
		try {
			dbClient = createDbClient(env);

			// Safety check: Ensure we're using a test database
			const libsqlUrlLower = env.TURSO_URL.toLowerCase();
			if (!libsqlUrlLower.includes("test-db")) {
				throw new Error(
					'Safety check failed: TURSO_URL must include "test-db" to run tests',
				);
			}
			console.info(`Running tests against: ${libsqlUrlLower}`);

			// Reset and initialize database
			for (const sql of [RESET_SQL, SCHEMA_SQL, TEST_USER_SQL]) {
				const statements = sql
					.split(";")
					.map((statement) => statement.trim())
					.filter(Boolean);

				for (const statement of statements) {
					await dbClient.execute(statement);
				}
			}
		} catch (error) {
			console.error("Error initializing database:", error);
			throw error;
		}
	});

	afterAll(async () => {
		try {
			await executeSQL(RESET_SQL, dbClient);
			dbClient.close();
		} catch (error) {
			console.error("Error cleaning up database:", error);
			throw error;
		}
	});

	it("Should successfully authenticate valid credentials", async () => {
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
