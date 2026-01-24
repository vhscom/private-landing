/**
 * @file password-service.test.ts
 * Unit tests for password hashing and verification service.
 *
 * @license Apache-2.0
 */

import {
	createPasswordService,
	defaultPasswordConfig,
	type PasswordService,
} from "@private-landing/core";
import { beforeEach, describe, expect, it } from "vitest";

describe("PasswordService", () => {
	let passwordService: PasswordService;

	beforeEach(() => {
		passwordService = createPasswordService();
	});

	describe("createPasswordService", () => {
		it("should create service with default config", () => {
			const service = createPasswordService();
			expect(service).toBeDefined();
			expect(service.hashPassword).toBeInstanceOf(Function);
			expect(service.verifyPassword).toBeInstanceOf(Function);
			expect(service.rejectPasswordWithConstantTime).toBeInstanceOf(Function);
			expect(service.isPasswordCompromised).toBeInstanceOf(Function);
		});

		it("should create service with custom config", () => {
			const service = createPasswordService({
				iterations: 50000,
				bits: 256,
			});
			expect(service).toBeDefined();
		});

		it("should throw error for invalid hash bits", () => {
			expect(() =>
				createPasswordService({
					// @ts-expect-error Testing invalid input
					bits: 128,
				}),
			).toThrow("Invalid hash bits - must be 256, 384, or 512");
		});
	});

	describe("hashPassword", () => {
		it("should hash a password and return formatted string", async () => {
			const password = "TestPassword123!";
			const hash = await passwordService.hashPassword(password);

			expect(hash).toBeDefined();
			expect(typeof hash).toBe("string");
			expect(hash.startsWith("$pbkdf2-sha384$v1$")).toBe(true);
		});

		it("should produce correct format with all components", async () => {
			const hash = await passwordService.hashPassword("password");
			const parts = hash.split("$");

			// Format: $algorithm$version$iterations$salt$hash$digest
			expect(parts).toHaveLength(7);
			expect(parts[0]).toBe(""); // Leading empty string from split
			expect(parts[1]).toBe("pbkdf2-sha384");
			expect(parts[2]).toBe("v1");
			expect(parts[3]).toBe(String(defaultPasswordConfig.iterations));
			expect(parts[4]).toBeTruthy(); // salt (base64)
			expect(parts[5]).toBeTruthy(); // hash (base64)
			expect(parts[6]).toBeTruthy(); // digest (base64)
		});

		it("should generate unique hashes for the same password", async () => {
			const password = "SamePassword123!";
			const hash1 = await passwordService.hashPassword(password);
			const hash2 = await passwordService.hashPassword(password);

			// Different salts should produce different hashes
			expect(hash1).not.toBe(hash2);
		});

		it("should handle unicode passwords", async () => {
			const unicodePassword = "Tëst🔐Pässwörd";
			const hash = await passwordService.hashPassword(unicodePassword);

			expect(hash).toBeDefined();
			expect(hash.startsWith("$pbkdf2-sha384$v1$")).toBe(true);
		});

		it("should handle empty password", async () => {
			const hash = await passwordService.hashPassword("");

			expect(hash).toBeDefined();
			expect(hash.startsWith("$pbkdf2-sha384$v1$")).toBe(true);
		});

		it("should handle long passwords", async () => {
			const longPassword = "a".repeat(1000);
			const hash = await passwordService.hashPassword(longPassword);

			expect(hash).toBeDefined();
			expect(hash.startsWith("$pbkdf2-sha384$v1$")).toBe(true);
		});
	});

	describe("verifyPassword", () => {
		it("should verify correct password", async () => {
			const password = "CorrectPassword123!";
			const hash = await passwordService.hashPassword(password);

			const isValid = await passwordService.verifyPassword(password, hash);
			expect(isValid).toBe(true);
		});

		it("should reject incorrect password", async () => {
			const password = "CorrectPassword123!";
			const hash = await passwordService.hashPassword(password);

			const isValid = await passwordService.verifyPassword(
				"WrongPassword",
				hash,
			);
			expect(isValid).toBe(false);
		});

		it("should reject with invalid hash format", async () => {
			const isValid = await passwordService.verifyPassword(
				"password",
				"invalid-hash-format",
			);
			expect(isValid).toBe(false);
		});

		it("should reject with incomplete hash", async () => {
			const isValid = await passwordService.verifyPassword(
				"password",
				"$pbkdf2-sha384$v1$100000$salt$hash",
			);
			expect(isValid).toBe(false);
		});

		it("should handle unicode passwords in verification", async () => {
			const unicodePassword = "Tëst🔐Pässwörd";
			const hash = await passwordService.hashPassword(unicodePassword);

			const isValid = await passwordService.verifyPassword(
				unicodePassword,
				hash,
			);
			expect(isValid).toBe(true);
		});

		it("should reject similar but different passwords", async () => {
			const password = "Password123!";
			const hash = await passwordService.hashPassword(password);

			// Test case sensitivity
			expect(await passwordService.verifyPassword("password123!", hash)).toBe(
				false,
			);

			// Test trailing space
			expect(await passwordService.verifyPassword("Password123! ", hash)).toBe(
				false,
			);

			// Test leading space
			expect(await passwordService.verifyPassword(" Password123!", hash)).toBe(
				false,
			);
		});
	});

	describe("rejectPasswordWithConstantTime", () => {
		it("should always return false", async () => {
			const result =
				await passwordService.rejectPasswordWithConstantTime("anypassword");
			expect(result).toBe(false);
		});

		it("should return false for empty password", async () => {
			const result = await passwordService.rejectPasswordWithConstantTime("");
			expect(result).toBe(false);
		});

		it("should return false for long password", async () => {
			const longPassword = "a".repeat(1000);
			const result =
				await passwordService.rejectPasswordWithConstantTime(longPassword);
			expect(result).toBe(false);
		});
	});

	describe("isPasswordCompromised", () => {
		it("should detect repetitive character passwords", async () => {
			const result = await passwordService.isPasswordCompromised("aaaaaaaa");
			expect(result.isCompromised).toBe(true);
			expect(result.reason).toContain("repetitive");
		});

		it("should detect sequential patterns starting with 123", async () => {
			const result = await passwordService.isPasswordCompromised("12345678");
			expect(result.isCompromised).toBe(true);
			expect(result.reason).toContain("sequential");
		});

		it("should detect sequential patterns starting with abc", async () => {
			const result = await passwordService.isPasswordCompromised("abcdefgh");
			expect(result.isCompromised).toBe(true);
			expect(result.reason).toContain("sequential");
		});

		it("should detect qwerty patterns", async () => {
			const result = await passwordService.isPasswordCompromised("qwertyui");
			expect(result.isCompromised).toBe(true);
			expect(result.reason).toContain("sequential");
		});

		it("should accept strong passwords", async () => {
			const result =
				await passwordService.isPasswordCompromised("MyStr0ng!Pass#2024");
			expect(result.isCompromised).toBe(false);
			expect(result.reason).toBeUndefined();
		});

		it("should be case insensitive for sequential detection", async () => {
			const result = await passwordService.isPasswordCompromised("ABC12345");
			expect(result.isCompromised).toBe(true);
		});
	});

	describe("cross-service verification", () => {
		it("should verify password hashed by different service instance", async () => {
			const service1 = createPasswordService();
			const service2 = createPasswordService();

			const password = "CrossServiceTest!";
			const hash = await service1.hashPassword(password);

			const isValid = await service2.verifyPassword(password, hash);
			expect(isValid).toBe(true);
		});

		it("should handle different bit configurations", async () => {
			const service256 = createPasswordService({ bits: 256 });
			const service384 = createPasswordService({ bits: 384 });

			const password = "TestPassword!";
			const hash256 = await service256.hashPassword(password);
			const hash384 = await service384.hashPassword(password);

			// Each service should verify its own hashes
			expect(await service256.verifyPassword(password, hash256)).toBe(true);
			expect(await service384.verifyPassword(password, hash384)).toBe(true);

			// Hash format should indicate the algorithm
			expect(hash256).toContain("sha256");
			expect(hash384).toContain("sha384");
		});
	});
});
