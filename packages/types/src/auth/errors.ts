/**
 * @file errors.ts
 * Error hierarchy for authentication and authorization failures.
 * Provides specific error types and status codes following HTTP semantics.
 *
 * Usage:
 * - 401 Unauthorized: Missing/invalid credentials or tokens
 * - 403 Forbidden: Valid auth but insufficient permissions
 * - 409 Conflict: Resource conflicts (e.g., session limits)
 * - 429 Too Many Requests: Rate limiting
 *
 * @license Apache-2.0
 */

/**
 * Base authentication error providing status codes and error categorization.
 * Extended by specific error types for different authentication failures.
 */
export class AuthenticationError extends Error {
	constructor(
		message: string,
		readonly code: string,
		readonly statusCode: number,
	) {
		super(message);
		this.name = "AuthenticationError";
		Object.setPrototypeOf(this, AuthenticationError.prototype);
	}
}

/**
 * JWT and refresh token related errors.
 * Handles both validation failures and token lifecycle issues.
 */
export class TokenError extends AuthenticationError {
	constructor(message: string, code = "INVALID_TOKEN", statusCode = 401) {
		super(message, code, statusCode);
		this.name = "TokenError";
		Object.setPrototypeOf(this, TokenError.prototype);
	}

	/** @returns TokenError with 400 Bad Request - Token structure or format invalid */
	static malformed(message = "Malformed token") {
		return new TokenError(message, "TOKEN_MALFORMED", 400);
	}

	/** @returns TokenError with 401 Unauthorized - Token has expired or is invalid */
	static expired(message = "Token expired") {
		return new TokenError(message, "TOKEN_EXPIRED", 401);
	}
}

/**
 * Session management errors including lifecycle and concurrent session handling.
 * Covers session validation, revocation, and limit enforcement.
 */
export class SessionError extends AuthenticationError {
	constructor(message: string, code = "SESSION_ERROR", statusCode = 401) {
		super(message, code, statusCode);
		this.name = "SessionError";
		Object.setPrototypeOf(this, SessionError.prototype);
	}

	/** @returns SessionError with 403 Forbidden - Session invalidated by logout or admin action */
	static revoked(message = "Session revoked") {
		return new SessionError(message, "SESSION_REVOKED", 403);
	}

	/** @returns SessionError with 409 Conflict - User has reached maximum allowed concurrent sessions */
	static limitExceeded(message = "Session limit exceeded") {
		return new SessionError(message, "MAX_SESSIONS", 409);
	}
}

/**
 * Rate limiting enforcement errors.
 * Used when request frequency exceeds defined thresholds.
 */
export class RateLimitError extends AuthenticationError {
	/** @returns RateLimitError with 429 Too Many Requests - Request frequency exceeds allowed rate */
	constructor(message = "Too many requests", code = "RATE_LIMIT") {
		super(message, code, 429);
		this.name = "RateLimitError";
		Object.setPrototypeOf(this, RateLimitError.prototype);
	}
}

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
		Object.setPrototypeOf(this, ValidationError.prototype);
	}
}
