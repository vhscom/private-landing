/**
 * @file zod.ts
 * Zod-specific validation utilities.
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
