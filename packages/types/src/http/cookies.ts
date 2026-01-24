/**
 * @file cookies.ts
 * HTTP cookie configuration types for authentication system.
 * Defines types for cookie settings and management.
 *
 * @license Apache-2.0
 */

/**
 * Cookie options matching Hono's CookieOptions interface.
 * Used for setting secure cookie attributes.
 */
export interface CookieOptions {
	domain?: string;
	expires?: Date;
	httpOnly?: boolean;
	maxAge?: number;
	path?: string;
	secure?: boolean;
	signingKey?: string;
	sameSite?: "Strict" | "Lax" | "None";
	partitioned?: boolean;
}
