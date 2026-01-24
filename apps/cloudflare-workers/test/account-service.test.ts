/**
 * @file account-service.test.ts
 * Unit tests for account management service.
 *
 * @license Apache-2.0
 */

import {
	type PasswordService,
	createAccountService,
} from "@private-landing/core";
import { ValidationError } from "@private-landing/errors";
import type { Env, UnauthenticatedState } from "@private-landing/types";
import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

// Mock database client
function createMockDbClient() {
	return {
		execute: vi.fn(),
		batch: vi.fn(),
		transaction: vi.fn(),
		executeMultiple: vi.fn(),
		sync: vi.fn(),
		close: vi.fn(),
		migrate: vi.fn(),
		closed: false,
		protocol: "http" as const,
	};
}

// Mock password service
function createMockPasswordService(): PasswordService {
	return {
		hashPassword: vi
			.fn()
			.mockResolvedValue("$pbkdf2-sha384$v1$100000$salt$hash$digest"),
		verifyPassword: vi.fn().mockResolvedValue(true),
		rejectPasswordWithConstantTime: vi.fn().mockResolvedValue(undefined),
		isPasswordCompromised: vi.fn().mockResolvedValue(false),
	};
}

// Test environment
const testEnv: Env = {
	AUTH_DB_URL: "libsql://test.turso.io",
	AUTH_DB_TOKEN: "test-token",
	JWT_ACCESS_SECRET: "test-access-secret",
	JWT_REFRESH_SECRET: "test-refresh-secret",
};

describe("AccountService", () => {
	let mockDbClient: ReturnType<typeof createMockDbClient>;
	let mockCreateDbClient: Mock;
	let mockPasswordService: PasswordService;

	beforeEach(() => {
		mockDbClient = createMockDbClient();
		mockCreateDbClient = vi.fn(() => mockDbClient);
		mockPasswordService = createMockPasswordService();
	});

	describe("createAccountService", () => {
		it("should create service with default configuration", () => {
			const service = createAccountService({
				createDbClient: mockCreateDbClient,
				passwordService: mockPasswordService,
			});

			expect(service).toBeDefined();
			expect(service.createAccount).toBeDefined();
			expect(service.authenticate).toBeDefined();
		});

		it("should create service with custom table configuration", () => {
			const service = createAccountService({
				tableName: "users",
				emailColumn: "email_address",
				passwordColumn: "password_hash",
				idColumn: "user_id",
				createDbClient: mockCreateDbClient,
			});

			expect(service).toBeDefined();
		});
	});

	describe("createAccount", () => {
		it("should create account with valid input", async () => {
			mockDbClient.execute.mockResolvedValueOnce({
				rowsAffected: 1,
				lastInsertRowid: BigInt(1),
			});

			const service = createAccountService({
				createDbClient: mockCreateDbClient,
				passwordService: mockPasswordService,
			});

			const result = await service.createAccount(
				{ email: "test@example.com", password: "SecurePassword123!" },
				testEnv,
			);

			expect(result.rowsAffected).toBe(1);
			expect(mockPasswordService.hashPassword).toHaveBeenCalledWith(
				"SecurePassword123!",
			);
		});

		it("should store hashed password, not plaintext", async () => {
			mockDbClient.execute.mockResolvedValueOnce({ rowsAffected: 1 });

			const service = createAccountService({
				createDbClient: mockCreateDbClient,
				passwordService: mockPasswordService,
			});

			await service.createAccount(
				{ email: "test@example.com", password: "MyPassword123!" },
				testEnv,
			);

			const insertCall = mockDbClient.execute.mock.calls[0];
			expect(insertCall[0].args[1]).toBe(
				"$pbkdf2-sha384$v1$100000$salt$hash$digest",
			);
			expect(insertCall[0].args[1]).not.toBe("MyPassword123!");
		});

		it("should throw ValidationError for invalid email", async () => {
			const service = createAccountService({
				createDbClient: mockCreateDbClient,
				passwordService: mockPasswordService,
			});

			await expect(
				service.createAccount(
					{ email: "invalid-email", password: "SecurePassword123!" },
					testEnv,
				),
			).rejects.toThrow(ValidationError);
		});

		it("should throw ValidationError for short password", async () => {
			const service = createAccountService({
				createDbClient: mockCreateDbClient,
				passwordService: mockPasswordService,
			});

			await expect(
				service.createAccount(
					{ email: "test@example.com", password: "short" },
					testEnv,
				),
			).rejects.toThrow(ValidationError);
		});

		it("should throw ValidationError for empty email", async () => {
			const service = createAccountService({
				createDbClient: mockCreateDbClient,
				passwordService: mockPasswordService,
			});

			await expect(
				service.createAccount(
					{ email: "", password: "SecurePassword123!" },
					testEnv,
				),
			).rejects.toThrow(ValidationError);
		});

		it("should use custom table names in INSERT query", async () => {
			mockDbClient.execute.mockResolvedValueOnce({ rowsAffected: 1 });

			const service = createAccountService({
				tableName: "users",
				emailColumn: "email_address",
				passwordColumn: "password_hash",
				createDbClient: mockCreateDbClient,
				passwordService: mockPasswordService,
			});

			await service.createAccount(
				{ email: "test@example.com", password: "SecurePassword123!" },
				testEnv,
			);

			const insertCall = mockDbClient.execute.mock.calls[0];
			expect(insertCall[0].sql).toContain("INSERT INTO users");
			expect(insertCall[0].sql).toContain("email_address");
			expect(insertCall[0].sql).toContain("password_hash");
		});

		it("should pass email to database correctly", async () => {
			mockDbClient.execute.mockResolvedValueOnce({ rowsAffected: 1 });

			const service = createAccountService({
				createDbClient: mockCreateDbClient,
				passwordService: mockPasswordService,
			});

			await service.createAccount(
				{ email: "USER@Example.COM", password: "SecurePassword123!" },
				testEnv,
			);

			const insertCall = mockDbClient.execute.mock.calls[0];
			// Email should be lowercased by schema validation
			expect(insertCall[0].args[0]).toBe("user@example.com");
		});
	});

	describe("authenticate", () => {
		it("should authenticate valid credentials", async () => {
			mockDbClient.execute.mockResolvedValueOnce({
				rows: [
					{
						id: 42,
						password_data: "$pbkdf2-sha384$v1$100000$salt$hash$digest",
					},
				],
			});

			const service = createAccountService({
				createDbClient: mockCreateDbClient,
				passwordService: mockPasswordService,
			});

			const result = await service.authenticate(
				{ email: "test@example.com", password: "CorrectPassword123!" },
				testEnv,
			);

			expect(result.authenticated).toBe(true);
			expect(result.userId).toBe(42);
			expect("error" in result).toBe(false);
		});

		it("should reject invalid password", async () => {
			mockDbClient.execute.mockResolvedValueOnce({
				rows: [
					{ id: 1, password_data: "$pbkdf2-sha384$v1$100000$salt$hash$digest" },
				],
			});

			(mockPasswordService.verifyPassword as Mock).mockResolvedValueOnce(false);

			const service = createAccountService({
				createDbClient: mockCreateDbClient,
				passwordService: mockPasswordService,
			});

			const result = await service.authenticate(
				{ email: "test@example.com", password: "WrongPassword123!" },
				testEnv,
			);

			expect(result.authenticated).toBe(false);
			expect(result.userId).toBeNull();
			expect((result as UnauthenticatedState).error).toBe(
				"Invalid email or password",
			);
		});

		it("should reject non-existent user with constant-time operation", async () => {
			mockDbClient.execute.mockResolvedValueOnce({ rows: [] });

			const service = createAccountService({
				createDbClient: mockCreateDbClient,
				passwordService: mockPasswordService,
			});

			const result = await service.authenticate(
				{ email: "unknown@example.com", password: "SomePassword123!" },
				testEnv,
			);

			expect(result.authenticated).toBe(false);
			expect(result.userId).toBeNull();
			expect((result as UnauthenticatedState).error).toBe(
				"Invalid email or password",
			);
			expect(
				mockPasswordService.rejectPasswordWithConstantTime,
			).toHaveBeenCalledWith("SomePassword123!");
		});

		it("should return validation error for invalid email format", async () => {
			const service = createAccountService({
				createDbClient: mockCreateDbClient,
				passwordService: mockPasswordService,
			});

			const result = await service.authenticate(
				{ email: "not-an-email", password: "SomePassword123!" },
				testEnv,
			);

			expect(result.authenticated).toBe(false);
			expect(result.userId).toBeNull();
			expect((result as UnauthenticatedState).error).toBeDefined();
			expect(mockDbClient.execute).not.toHaveBeenCalled();
		});

		it("should return validation error for empty password", async () => {
			const service = createAccountService({
				createDbClient: mockCreateDbClient,
				passwordService: mockPasswordService,
			});

			const result = await service.authenticate(
				{ email: "test@example.com", password: "" },
				testEnv,
			);

			expect(result.authenticated).toBe(false);
			expect(result.userId).toBeNull();
			expect((result as UnauthenticatedState).error).toBeDefined();
		});

		it("should use custom column names in SELECT query", async () => {
			mockDbClient.execute.mockResolvedValueOnce({
				rows: [
					{
						user_id: 1,
						password_hash: "$pbkdf2-sha384$v1$100000$salt$hash$digest",
					},
				],
			});

			const service = createAccountService({
				tableName: "users",
				emailColumn: "email_address",
				passwordColumn: "password_hash",
				idColumn: "user_id",
				createDbClient: mockCreateDbClient,
				passwordService: mockPasswordService,
			});

			await service.authenticate(
				{ email: "test@example.com", password: "Password123!" },
				testEnv,
			);

			const selectCall = mockDbClient.execute.mock.calls[0];
			expect(selectCall[0].sql).toContain("SELECT password_hash, user_id");
			expect(selectCall[0].sql).toContain("FROM users");
			expect(selectCall[0].sql).toContain("email_address = ?");
		});

		it("should handle account with invalid id type", async () => {
			mockDbClient.execute.mockResolvedValueOnce({
				rows: [
					{
						id: "not-a-number",
						password_data: "$pbkdf2-sha384$v1$100000$salt$hash$digest",
					},
				],
			});

			const service = createAccountService({
				createDbClient: mockCreateDbClient,
				passwordService: mockPasswordService,
			});

			const result = await service.authenticate(
				{ email: "test@example.com", password: "Password123!" },
				testEnv,
			);

			expect(result.authenticated).toBe(false);
			expect(result.userId).toBeNull();
			expect((result as UnauthenticatedState).error).toBe(
				"Invalid account state",
			);
		});

		it("should pass password to verifyPassword correctly", async () => {
			mockDbClient.execute.mockResolvedValueOnce({
				rows: [
					{
						id: 1,
						password_data:
							"$pbkdf2-sha384$v1$100000$storedSalt$storedHash$digest",
					},
				],
			});

			const service = createAccountService({
				createDbClient: mockCreateDbClient,
				passwordService: mockPasswordService,
			});

			await service.authenticate(
				{ email: "test@example.com", password: "TestPassword123!" },
				testEnv,
			);

			expect(mockPasswordService.verifyPassword).toHaveBeenCalledWith(
				"TestPassword123!",
				"$pbkdf2-sha384$v1$100000$storedSalt$storedHash$digest",
			);
		});
	});

	describe("dependency injection", () => {
		it("should use injected password service", async () => {
			const customPasswordService = createMockPasswordService();
			mockDbClient.execute.mockResolvedValueOnce({ rowsAffected: 1 });

			const service = createAccountService({
				createDbClient: mockCreateDbClient,
				passwordService: customPasswordService,
			});

			await service.createAccount(
				{ email: "test@example.com", password: "SecurePassword123!" },
				testEnv,
			);

			expect(customPasswordService.hashPassword).toHaveBeenCalled();
		});

		it("should use injected database client factory", async () => {
			const customFactory = vi.fn(() => mockDbClient);
			mockDbClient.execute.mockResolvedValueOnce({ rowsAffected: 1 });

			const service = createAccountService({
				createDbClient: customFactory,
				passwordService: mockPasswordService,
			});

			await service.createAccount(
				{ email: "test@example.com", password: "SecurePassword123!" },
				testEnv,
			);

			expect(customFactory).toHaveBeenCalledWith(testEnv);
		});

		it("should pass environment to database client factory in authenticate", async () => {
			const customEnv: Env = {
				AUTH_DB_URL: "libsql://custom.turso.io",
				AUTH_DB_TOKEN: "custom-token",
				JWT_ACCESS_SECRET: "custom-access",
				JWT_REFRESH_SECRET: "custom-refresh",
			};

			mockDbClient.execute.mockResolvedValueOnce({
				rows: [
					{ id: 1, password_data: "$pbkdf2-sha384$v1$100000$salt$hash$digest" },
				],
			});

			const service = createAccountService({
				createDbClient: mockCreateDbClient,
				passwordService: mockPasswordService,
			});

			await service.authenticate(
				{ email: "test@example.com", password: "Password123!" },
				customEnv,
			);

			expect(mockCreateDbClient).toHaveBeenCalledWith(customEnv);
		});
	});

	describe("security", () => {
		it("should perform constant-time rejection for non-existent users", async () => {
			mockDbClient.execute.mockResolvedValueOnce({ rows: [] });

			const service = createAccountService({
				createDbClient: mockCreateDbClient,
				passwordService: mockPasswordService,
			});

			await service.authenticate(
				{ email: "unknown@example.com", password: "AnyPassword123!" },
				testEnv,
			);

			// Should call rejectPasswordWithConstantTime to prevent timing attacks
			expect(
				mockPasswordService.rejectPasswordWithConstantTime,
			).toHaveBeenCalled();
		});

		it("should not reveal whether email exists in error message", async () => {
			mockDbClient.execute.mockResolvedValueOnce({ rows: [] });

			const service = createAccountService({
				createDbClient: mockCreateDbClient,
				passwordService: mockPasswordService,
			});

			const result = await service.authenticate(
				{ email: "unknown@example.com", password: "Password123!" },
				testEnv,
			);

			// Error message should be generic
			const error = (result as UnauthenticatedState).error;
			expect(error).toBe("Invalid email or password");
			expect(error).not.toContain("not found");
			expect(error).not.toContain("does not exist");
		});

		it("should return same error for wrong password as for non-existent user", async () => {
			// Test non-existent user
			mockDbClient.execute.mockResolvedValueOnce({ rows: [] });
			const service = createAccountService({
				createDbClient: mockCreateDbClient,
				passwordService: mockPasswordService,
			});
			const notFoundResult = await service.authenticate(
				{ email: "unknown@example.com", password: "Password123!" },
				testEnv,
			);

			// Test wrong password
			mockDbClient.execute.mockResolvedValueOnce({
				rows: [
					{ id: 1, password_data: "$pbkdf2-sha384$v1$100000$salt$hash$digest" },
				],
			});
			(mockPasswordService.verifyPassword as Mock).mockResolvedValueOnce(false);
			const wrongPwdResult = await service.authenticate(
				{ email: "test@example.com", password: "WrongPassword123!" },
				testEnv,
			);

			// Both should return the same generic error
			expect((notFoundResult as UnauthenticatedState).error).toBe(
				(wrongPwdResult as UnauthenticatedState).error,
			);
		});
	});

	describe("email normalization", () => {
		it("should lowercase email before storing", async () => {
			mockDbClient.execute.mockResolvedValueOnce({ rowsAffected: 1 });

			const service = createAccountService({
				createDbClient: mockCreateDbClient,
				passwordService: mockPasswordService,
			});

			await service.createAccount(
				{ email: "TEST@EXAMPLE.COM", password: "SecurePassword123!" },
				testEnv,
			);

			const insertCall = mockDbClient.execute.mock.calls[0];
			expect(insertCall[0].args[0]).toBe("test@example.com");
		});

		it("should lowercase email before authentication lookup", async () => {
			mockDbClient.execute.mockResolvedValueOnce({
				rows: [
					{ id: 1, password_data: "$pbkdf2-sha384$v1$100000$salt$hash$digest" },
				],
			});

			const service = createAccountService({
				createDbClient: mockCreateDbClient,
				passwordService: mockPasswordService,
			});

			await service.authenticate(
				{ email: "TEST@EXAMPLE.COM", password: "Password123!" },
				testEnv,
			);

			const selectCall = mockDbClient.execute.mock.calls[0];
			expect(selectCall[0].args[0]).toBe("test@example.com");
		});
	});
});
