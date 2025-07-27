/**
 * @file authentication.ts
 * Core authentication types for login, registration, and auth state.
 * Defines the fundamental types for authentication flows and results.
 *
 * @license Apache-2.0
 */

import type {
	LoginInput,
	RegistrationInput,
	RegistrationOutput,
} from "@private-landing/schemas";

// Re-export schema types
export type { LoginInput, RegistrationInput, RegistrationOutput };

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
