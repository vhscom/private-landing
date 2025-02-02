/**
 * @file auth.types.ts
 * Type definitions for authentication system.
 * Centralizes types used across auth services, handlers and middleware.
 *
 * @license LGPL-3.0-or-later
 */

import type { CookieOptions } from "hono/utils/cookie";
import type {
	LoginInput,
	RegistrationInput,
	RegistrationOutput,
} from "../schemas/auth.schema";

// Re-export schema types
export type { LoginInput, RegistrationInput, RegistrationOutput };

/**
 * Result of an authentication attempt.
 * @property authenticated - Whether the credentials were valid
 * @property userId - The user's ID if authentication succeeded, null otherwise
 * @property error - Optional error message if authentication failed
 */
export interface AuthResult {
	authenticated: boolean;
	userId: number | null;
	error?: string;
}

/**
 * Standard payload structure for JWT tokens.
 * @property uid - User identifier
 * @property sid - Session identifier
 * @property typ - Token type discriminator
 * @property exp - Optional expiration timestamp
 */
export interface TokenPayload {
	uid: number;
	sid: string;
	typ: "access" | "refresh";
	exp?: number;
	[key: string]: string | number | undefined;
}

/**
 * Session state information stored in database.
 * @property id - 21 character nanoid session identifier
 * @property userId - Associated user ID
 * @property userAgent - Browser user agent string
 * @property ipAddress - Client IP address
 * @property expiresAt - Session expiration timestamp
 * @property createdAt - Session creation timestamp
 */
export interface SessionState {
	id: string;
	userId: number;
	userAgent: string;
	ipAddress: string;
	expiresAt: string;
	createdAt: string;
}

/**
 * JWT token configuration settings.
 * @property accessTokenExpiry - Access token lifetime in seconds
 * @property refreshTokenExpiry - Refresh token lifetime in seconds
 * @property cookieSecure - Whether to set Secure flag on cookies
 * @property cookieSameSite - SameSite cookie policy
 */
export interface TokenConfig {
	accessTokenExpiry: number;
	refreshTokenExpiry: number;
	cookieSecure: boolean;
	cookieSameSite: "Strict" | "Lax" | "None";
}

/**
 * Configuration for session management.
 * @property maxSessions - Maximum active sessions per user
 * @property sessionDuration - Session duration in seconds
 * @property maintenanceWindow - Age of sessions to clean up in days
 * @property cookie - Cookie configuration options
 */
export interface SessionConfig {
	maxSessions: number;
	sessionDuration: number;
	maintenanceWindow: number;
	cookie: CookieOptions;
}
