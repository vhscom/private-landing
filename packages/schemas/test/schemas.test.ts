/**
 * @file schemas.test.ts
 * Unit tests for validation schemas following NIST SP 800-63B requirements.
 *
 * @license Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { loginSchema, registrationSchema } from "../src/auth/credentials";
import { normalizePassword } from "../src/auth/password";
import { formatZodError } from "../src/utils/zod";

describe("Validation Schemas", () => {
	describe("loginSchema", () => {
		it("should accept valid credentials", async () => {
			const result = await loginSchema.safeParseAsync({
				email: "user@example.com",
				password: "ValidPassword123",
			});

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.email).toBe("user@example.com");
				expect(result.data.password).toBe("ValidPassword123");
			}
		});

		it("should normalize email to lowercase", async () => {
			const result = await loginSchema.safeParseAsync({
				email: "USER@EXAMPLE.COM",
				password: "ValidPassword123",
			});

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.email).toBe("user@example.com");
			}
		});

		it("should reject email with whitespace (validation before trim)", async () => {
			// Note: Zod validates email() BEFORE applying trim()
			// So emails with leading/trailing spaces fail validation
			const result = await loginSchema.safeParseAsync({
				email: "  user@example.com  ",
				password: "ValidPassword123",
			});

			expect(result.success).toBe(false);
		});

		it("should reject invalid email format", async () => {
			const result = await loginSchema.safeParseAsync({
				email: "not-an-email",
				password: "ValidPassword123",
			});

			expect(result.success).toBe(false);
		});

		it("should reject empty email", async () => {
			const result = await loginSchema.safeParseAsync({
				email: "",
				password: "ValidPassword123",
			});

			expect(result.success).toBe(false);
		});

		it("should reject password shorter than 8 characters", async () => {
			const result = await loginSchema.safeParseAsync({
				email: "user@example.com",
				password: "short",
			});

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(formatZodError(result.error)).toContain("8 characters");
			}
		});

		it("should reject password longer than 64 characters", async () => {
			const result = await loginSchema.safeParseAsync({
				email: "user@example.com",
				password: "a".repeat(65),
			});

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(formatZodError(result.error)).toContain("64 characters");
			}
		});

		it("should accept exactly 8 character password", async () => {
			const result = await loginSchema.safeParseAsync({
				email: "user@example.com",
				password: "12345678",
			});

			expect(result.success).toBe(true);
		});

		it("should accept exactly 64 character password", async () => {
			const result = await loginSchema.safeParseAsync({
				email: "user@example.com",
				password: "a".repeat(64),
			});

			expect(result.success).toBe(true);
		});

		it("should normalize password with NFKC", async () => {
			// Test Unicode normalization
			const result = await loginSchema.safeParseAsync({
				email: "user@example.com",
				password: "café\u0301test", // café with combining accent
			});

			expect(result.success).toBe(true);
		});

		it("should normalize multiple spaces in password", async () => {
			const result = await loginSchema.safeParseAsync({
				email: "user@example.com",
				password: "pass  word   test",
			});

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.password).toBe("pass word test");
			}
		});

		it("should reject missing email", async () => {
			const result = await loginSchema.safeParseAsync({
				password: "ValidPassword123",
			});

			expect(result.success).toBe(false);
		});

		it("should reject missing password", async () => {
			const result = await loginSchema.safeParseAsync({
				email: "user@example.com",
			});

			expect(result.success).toBe(false);
		});
	});

	describe("registrationSchema", () => {
		it("should accept valid registration data", async () => {
			const result = await registrationSchema.safeParseAsync({
				email: "newuser@example.com",
				password: "SecurePassword123",
			});

			expect(result.success).toBe(true);
		});

		it("should inherit all loginSchema validations", async () => {
			// Test email normalization (lowercase)
			const emailResult = await registrationSchema.safeParseAsync({
				email: "USER@EXAMPLE.COM",
				password: "ValidPassword123",
			});

			expect(emailResult.success).toBe(true);
			if (emailResult.success) {
				expect(emailResult.data.email).toBe("user@example.com");
			}

			// Test password length validation
			const shortResult = await registrationSchema.safeParseAsync({
				email: "user@example.com",
				password: "short",
			});

			expect(shortResult.success).toBe(false);
		});

		it("should handle unicode passwords", async () => {
			const result = await registrationSchema.safeParseAsync({
				email: "user@example.com",
				password: "Tëst🔐Pässwörd",
			});

			expect(result.success).toBe(true);
		});
	});

	describe("normalizePassword", () => {
		it("should apply NFKC normalization", () => {
			// Decomposed form (e + combining acute)
			const decomposed = "cafe\u0301";
			const normalized = normalizePassword(decomposed);

			// Should become composed form
			expect(normalized).toBe("café");
		});

		it("should normalize multiple spaces to single space", () => {
			expect(normalizePassword("pass  word")).toBe("pass word");
			expect(normalizePassword("pass   word")).toBe("pass word");
			expect(normalizePassword("a  b  c")).toBe("a b c");
		});

		it("should normalize tabs to spaces", () => {
			expect(normalizePassword("pass\tword")).toBe("pass word");
		});

		it("should normalize newlines to spaces", () => {
			expect(normalizePassword("pass\nword")).toBe("pass word");
		});

		it("should preserve single spaces", () => {
			expect(normalizePassword("pass word test")).toBe("pass word test");
		});

		it("should handle empty string", () => {
			expect(normalizePassword("")).toBe("");
		});

		it("should handle passwords with only spaces", () => {
			expect(normalizePassword("        ")).toBe(" ");
		});

		it("should normalize compatibility characters", () => {
			// Full-width characters should normalize
			expect(normalizePassword("ＡＢＣ")).toBe("ABC");
		});
	});

	describe("formatZodError", () => {
		it("should format validation errors from loginSchema", async () => {
			const result = await loginSchema.safeParseAsync({
				email: "invalid",
				password: "short",
			});

			expect(result.success).toBe(false);
			if (!result.success) {
				const message = formatZodError(result.error);
				expect(message).toContain("Invalid email");
			}
		});

		it("should join multiple errors with comma", async () => {
			const result = await loginSchema.safeParseAsync({
				email: "invalid",
				password: "short",
			});

			expect(result.success).toBe(false);
			if (!result.success) {
				const message = formatZodError(result.error);
				// Should contain both error messages
				expect(message).toContain("Invalid email");
				expect(message).toContain("8 characters");
			}
		});
	});

	describe("NIST SP 800-63B compliance", () => {
		it("should not impose composition rules (no special char requirement)", async () => {
			// NIST recommends against complexity requirements
			const result = await loginSchema.safeParseAsync({
				email: "user@example.com",
				password: "simplepassword", // No special chars, no numbers, no uppercase
			});

			expect(result.success).toBe(true);
		});

		it("should allow spaces in passwords", async () => {
			// NIST allows all printing characters including space
			const result = await loginSchema.safeParseAsync({
				email: "user@example.com",
				password: "pass word with spaces",
			});

			expect(result.success).toBe(true);
		});

		it("should allow all unicode characters", async () => {
			const result = await loginSchema.safeParseAsync({
				email: "user@example.com",
				password: "密码密码密码密码", // Chinese characters (8 chars)
			});

			expect(result.success).toBe(true);
		});

		it("should allow emoji in passwords", async () => {
			const result = await loginSchema.safeParseAsync({
				email: "user@example.com",
				password: "🔐🔑🔒🔓🔐🔑🔒🔓", // 8 emoji
			});

			expect(result.success).toBe(true);
		});

		it("should check length after normalization", async () => {
			// Multiple spaces that normalize to single space
			const result = await loginSchema.safeParseAsync({
				email: "user@example.com",
				password: "a       b", // Would be 9 chars but normalizes to "a b" (3 chars)
			});

			// This should fail because after normalization it's too short
			expect(result.success).toBe(false);
		});
	});
});
