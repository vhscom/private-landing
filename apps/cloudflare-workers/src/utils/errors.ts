/**
 * @file errors.ts
 * Custom error types and factory functions for validation handling.
 *
 * @license Apache-2.0
 */

/**
 * Error type for password validation failures.
 * Provides structured error information for UI feedback.
 * @property code - Error type identifier
 * @property field - Form field that caused validation failure
 * @property message - User-friendly error description
 */
interface PasswordValidationError extends Error {
	code: "VALIDATION_ERROR";
	field: string;
}

/**
 * Creates a typed validation error.
 * @param message - User-friendly error message
 * @param field - Form field that failed validation
 */
export function createValidationError(
	message: string,
	field: string,
): PasswordValidationError {
	const error = new Error(message) as PasswordValidationError;
	error.code = "VALIDATION_ERROR";
	error.field = field;
	return error;
}
