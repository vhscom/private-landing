/**
 * @file cookies.ts
 * HTTP cookie configuration types for authentication system.
 * Defines types for cookie settings and management.
 *
 * @license Apache-2.0
 */

/**
 * Base cookie options matching Hono's CookieOptions interface
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

/**
 * Extended cookie options specific to authentication system
 */
export interface AuthCookieOptions extends CookieOptions {
	name: string;
	maxAge: number; // Required in auth system, optional in base
}
