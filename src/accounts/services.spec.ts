import { describe, expect, mock, test } from "bun:test";
import type { ResultSet } from "@libsql/client";
import { accountService } from "./services.ts";

const mockEnv = {
	TURSO_URL: "libsql://test",
	TURSO_AUTH_TOKEN: "test",
} as Env;

const createMockResult = (
	override: Partial<ResultSet> = {},
): Partial<ResultSet> => ({
	rowsAffected: 1,
	lastInsertRowid: BigInt(1),
	rows: [],
	columns: [],
	columnTypes: [],
	...override,
});

describe("Account Service", () => {
	describe("Account Creation", () => {
		mock.module("../db.ts", () => ({
			createDbClient: () => ({
				execute: async () => createMockResult(),
			}),
		}));

		test("rejects passwords shorter than 8 characters", async () => {
			expect(
				accountService.createAccount("test@example.com", "short", mockEnv),
			).rejects.toThrow(/Password must be at least 8 characters long/i);
		});

		test("successfully creates account with valid password", async () => {
			const result = await accountService.createAccount(
				"test@example.com",
				"validPassword123",
				mockEnv,
			);
			expect(result.rowsAffected).toBe(1);
			expect(result.lastInsertRowid).toBe(BigInt(1));
		});
	});

	describe("Authentication", () => {
		test("returns false for non-existent user", async () => {
			mock.module("../db.ts", () => ({
				createDbClient: () => ({
					execute: async () => createMockResult({ rows: [] }),
				}),
			}));

			const result = await accountService.authenticate(
				"nonexistent@example.com",
				"anypassword",
				mockEnv,
			);
			expect(result).toEqual({ authenticated: false });
		});

		test.skip("verifies correct password", async () => {
			const password = "correctPassword123";

			mock.module("../db.ts", () => ({
				createDbClient: () => ({
					execute: async () => createMockResult(),
				}),
			}));

			await accountService.createAccount("test@example.com", password, mockEnv);

			const storedPasswordData = await accountService.authenticate(
				"test@example.com",
				password,
				mockEnv,
			);

			expect(storedPasswordData).toEqual({ authenticated: true });
		});

		test("rejects incorrect password", async () => {
			mock.module("../db.ts", () => ({
				createDbClient: () => ({
					execute: async () =>
						createMockResult({
							rows: [
								{
									password_data:
										"$pbkdf2-sha384$v1$100000$somesalt$somehash$somedigest",
									length: 1,
									[Symbol.iterator]: function* () {
										yield this.password_data;
									},
								},
							],
						}),
				}),
			}));

			const result = await accountService.authenticate(
				"test@example.com",
				"wrongpassword",
				mockEnv,
			);
			expect(result).toEqual({ authenticated: false });
		});
	});

	describe("Password Format", () => {
		test("creates password data in correct format", async () => {
			let storedData = "";

			mock.module("../db.ts", () => ({
				createDbClient: () => ({
					execute: async ({
						sql: _,
						args,
					}: { sql: string; args: unknown[] }) => {
						storedData = args[1] as string;
						return createMockResult();
					},
				}),
			}));

			await accountService.createAccount(
				"test@example.com",
				"testPassword123",
				mockEnv,
			);

			expect(storedData).toMatch(
				/^\$pbkdf2-sha384\$v1\$100000\$[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*$/,
			);
		});
	});
});
