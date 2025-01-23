/**
 * @file token-config.ts
 * Configuration and types for JWT token management and authentication.
 *
 * @license LGPL-3.0-or-later
 */

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
 * Default token configuration settings.
 * Uses secure defaults with 15 minute access tokens
 * and 7 day refresh tokens.
 */
export const tokenConfig: TokenConfig = {
	accessTokenExpiry: 15 * 60, // 15 minutes
	refreshTokenExpiry: 7 * 24 * 3600, // 7 days
	cookieSecure: true,
	cookieSameSite: "Strict",
};
