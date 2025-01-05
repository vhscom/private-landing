import { describe, expect, test, mock, spyOn } from "bun:test";
import { accountService } from "./services";
import type { ResultSet } from "@libsql/client";

const mockResultSet: Partial<ResultSet> = {
	rowsAffected: 1,
	lastInsertRowid: BigInt(1),
};

mock.module("../db.ts", () => ({
	createDbClient: () => ({
		execute: async () => mockResultSet,
	}),
}));

describe("Account Service", () => {
	const mockEnv = {
		TURSO_URL: "libsql://test",
		TURSO_AUTH_TOKEN: "test",
	} as Env;

	test("createAccount hashes password correctly", async () => {
		const spy = spyOn(accountService, "createAccount");
		const email = "test@example.com";
		const password = "testPassword123";
		const result = await accountService.createAccount(email, password, mockEnv);
		expect(spy).toHaveBeenCalled();
		expect(spy.mock.calls).toEqual([[email, password, mockEnv]]);
		expect(result.rowsAffected).toBe(1);
	});
});
