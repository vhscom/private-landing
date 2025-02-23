/**
 * @file schema.ts
 * Schema validation utilities for handling errors and common checks.
 *
 * @license LGPL-3.0-or-later
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
	return error.errors.map((err) => err.message).join(", ");
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
