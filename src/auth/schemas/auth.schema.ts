/**
 * @file auth.schema.ts
 * Zod schemas for authentication and registration following NIST guidelines.
 * Implements NIST SP 800-63B requirements for memorized secrets.
 *
 * Key Requirements:
 * 1. Minimum 8 characters, maximum 64 characters
 * 2. Unicode support with NFKC normalization
 * 3. Allow all printing ASCII and space characters
 * 4. Space normalization preserving 8 char minimum
 * 5. No composition rules (special chars, mixed case, etc.)
 * 6. Check against common/compromised passwords
 *
 * @license LGPL-3.0-or-later
 */

import { z } from "zod";
import { isPasswordCompromised, normalizePassword } from "../utils/password.ts";
import { isEmailUnique } from "../utils/schema.ts";

/**
 * Base email validation schema with normalization.
 * Ensures consistent email format and case handling.
 */
const emailSchema = z
	.string()
	.email("Invalid email format")
	.transform((email) => email.toLowerCase().trim());

/**
 * Password validation schema implementing NIST SP 800-63B requirements.
 * Enforces length requirements and normalization while avoiding
 * composition rules that might lead to weaker passwords.
 *
 * Validation process:
 * 1. Basic length check (8-64 chars)
 * 2. Unicode normalization (NFKC)
 * 3. Space character normalization
 * 4. Length verification post-normalization
 * 5. Common password check
 */
const passwordSchema = z
	.string()
	.max(64, "Password must not exceed 64 characters")
	.transform(normalizePassword)
	.refine(
		(password) => [...password].length >= 8,
		"Password must be at least 8 characters (spaces may be consolidated)",
	)
	.superRefine(async (password, ctx) => {
		const check = await isPasswordCompromised(password);
		if (check.isCompromised) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: check.reason ?? "Password is too common or compromised",
			});
		}
	});

/**
 * Login credentials schema.
 * Applies NIST SP 800-63B compliant validation:
 * - Email normalization to prevent duplicate accounts
 * - Password normalization per NIST recommendations
 * - No composition rules (per NIST guidance against complexity requirements)
 *
 * @see ADR-002 for planned rate limiting implementation
 */
export const loginSchema = z.object({
	email: emailSchema,
	password: z.string().transform(normalizePassword),
});

/**
 * Registration schema with additional validations.
 * Implements NIST SP 800-63B and OWASP ASVS v4.0 requirements:
 * - Email uniqueness enforcement
 * - Password validation against common/compromised passwords
 * - Unicode normalization (NFKC)
 * - Space character normalization
 * - Length requirements (8-64 chars)
 * - No password hints or security questions
 *
 * Note: Password hashing and storage handled by password service
 */
export const registrationSchema = loginSchema
	.extend({
		email: emailSchema.superRefine(async (email, ctx) => {
			const isUnique = await isEmailUnique(email);
			if (!isUnique) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Email already registered",
				});
			}
		}),
		password: passwordSchema,
	})
	.transform((loginCredential) => ({
		...loginCredential,
		email: loginCredential.email.toLowerCase(),
	}));

/** Type for login credentials input validated by the login schema. */
export type LoginInput = z.infer<typeof loginSchema>;

/** Type for registration credentials input accepted by the registration schema. */
export type RegistrationInput = z.input<typeof registrationSchema>;

/** Type for normalized registration output returned by the registration schema. */
export type RegistrationOutput = z.output<typeof registrationSchema>;
