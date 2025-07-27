/**
 * @file token.ts
 * JWT token types and configuration for authentication system.
 * Defines types for token payloads and configuration settings.
 *
 * @license Apache-2.0
 */

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
