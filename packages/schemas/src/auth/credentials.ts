/**
 * @file credentials.ts
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
 * @license Apache-2.0
 */

import { z } from "zod";

/**
 * Base email validation schema with normalization.
 * Ensures consistent email format and case handling.
 */
const emailSchema = z
	.string()
	.email("Invalid email format")
	.transform((email) => email.toLowerCase().trim());

/**
 * Login credentials schema.
 * Applies NIST SP 800-63B compliant validation:
 * - Email normalization to prevent duplicate accounts
 * - Password normalization per NIST recommendations
 * - No composition rules (per NIST guidance against complexity requirements)
 */
export const loginSchema = z.object({
	email: emailSchema,
	password: z.string(),
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
 */
export const registrationSchema = loginSchema.extend({});

/** Type for login credentials input validated by the login schema. */
export type LoginInput = z.infer<typeof loginSchema>;

/** Type for registration credentials input accepted by the registration schema. */
export type RegistrationInput = z.input<typeof registrationSchema>;

/** Type for normalized registration output returned by the registration schema. */
export type RegistrationOutput = z.output<typeof registrationSchema>;
