/**
 * @file authentication.ts
 * Core authentication types for login, registration, and auth state.
 * Defines the fundamental types for authentication flows and results.
 *
 * @license Apache-2.0
 */

/**
 * Login credentials input.
 * Email will be normalized to lowercase, password will be NFKC normalized.
 */
export interface LoginInput {
	email: string;
	password: string;
}

/**
 * Registration credentials input.
 * Same structure as login for this simple auth system.
 */
export interface RegistrationInput {
	email: string;
	password: string;
}

/**
 * Registration output after validation and normalization.
 * Email is lowercased, password is NFKC normalized.
 */
export interface RegistrationOutput {
	email: string;
	password: string;
}

/**
 * Password change input.
 * Both passwords will be NFKC normalized before comparison.
 */
export interface PasswordChangeInput {
	currentPassword: string;
	newPassword: string;
}

/**
 * Represents a successful authentication with valid user ID
 */
export interface AuthenticatedState {
	authenticated: true;
	userId: number;
}

/**
 * Represents a failed authentication attempt
 */
export interface UnauthenticatedState {
	authenticated: false;
	userId: null;
	error?: string;
}

/**
 * Result of an authentication attempt.
 * Successful authentication must include a userId.
 * Failed authentication may include an error message.
 */
export type AuthResult = AuthenticatedState | UnauthenticatedState;
