/**
 * @file errors.ts
 * Error types and utilities for authentication error handling.
 * Provides consistent error types for validation and authentication failures.
 *
 * @license LGPL-3.0-or-later
 */

/**
 * Custom error for validation failures.
 * Used to distinguish validation errors that can be shown to users
 * from other types of errors that should be handled differently.
 */
export class ValidationError extends Error {
	readonly code = "VALIDATION_ERROR" as const;

	constructor(message: string) {
		super(message);
		this.name = "ValidationError";
		// Ensures proper prototype chain for instanceof checks
		Object.setPrototypeOf(this, ValidationError.prototype);
	}
}

/**
 * Creates a validation error with proper message.
 *
 * @param message - Error message to display
 * @param field - Optional field that failed validation
 * @returns ValidationError instance
 */
export function createValidationError(
	message: string,
	field?: string,
): ValidationError {
	const fullMessage = field ? `${field}: ${message}` : message;
	return new ValidationError(fullMessage);
}
