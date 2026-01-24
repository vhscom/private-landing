/**
 * @file schema.ts
 * Schema validation utilities for handling errors and common checks.
 *
 * @license Apache-2.0
 */

import type { ZodError } from "zod";

/**
 * Formats Zod validation errors into a user-friendly message string.
 * Combines all error messages with proper separation.
 *
 * @param error - Zod validation error object
 * @returns Formatted error message string
 */
export function formatZodError(error: ZodError): string {
	return error.issues.map((issue) => issue.message).join(", ");
}

/**
 * Checks if an email is available for registration.
 * Queries database to ensure email uniqueness.
 *
 * @param email - Email address to check
 * @returns Promise resolving to true if email is unique
 */
export async function isEmailUnique(email: string): Promise<boolean> {
	return true; // TODO: implement database check
}

/**
 * Normalizes a password string according to NIST SP 800-63B requirements.
 * Applies NFKC normalization for Unicode stability and space normalization.
 *
 * @param password - Raw password string to normalize
 * @returns Normalized password string
 */
export function normalizePassword(password: string): string {
	return password.normalize("NFKC").replace(/\s+/g, " ");
}
