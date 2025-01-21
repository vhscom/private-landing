import type { SqliteClient } from "../src/infrastructure/db/client";
import { RESET_SQL, SCHEMA_SQL, TEST_USER_SQL } from "./sql.ts";

export const executeSQL = async (sql: string, client: SqliteClient) => {
	const statements = sql
		.split(";")
		.map((statement) => statement.trim())
		.filter(Boolean);

	for (const statement of statements) {
		await client.execute(statement);
	}
};

export const initTestDB = async (client: SqliteClient, env: Env) => {
	// Safety check: Ensure we're using a test database
	const libsqlUrlLower = env.TURSO_URL.toLowerCase();
	if (!libsqlUrlLower.includes("test-db")) {
		throw new Error(
			'Safety check failed: TURSO_URL must include "test-db" to run tests',
		);
	}
	console.info(`Running tests against: ${libsqlUrlLower}`);

	// Reset and initialize database
	await executeSQL(RESET_SQL, client);
	await executeSQL(SCHEMA_SQL, client);
	await executeSQL(TEST_USER_SQL, client);
};
