/**
 * @file cookie.ts
 * Utilities for setting and configuring secure HTTP cookies for authentication tokens.
 * @license Apache-2.0
 */

import type { AuthCookieOptions } from "@private-landing/types";
import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import { tokenConfig } from "../config";

/**
 * Sets a cookie with secure and same site settings.
 * @param ctx - Hono context with auth bindings
 * @param name - Cookie name to set
 * @param token - JWT token to store in cookie
 * @param maxAge - Cookie expiration in seconds
 */
export function setSecureCookie(
	ctx: Context,
	name: string,
	token: string,
	maxAge: number,
): void {
	setCookie(ctx, name, token, {
		httpOnly: true,
		secure: tokenConfig.cookieSecure,
		sameSite: tokenConfig.cookieSameSite,
		path: "/",
		maxAge,
	});
}

/**
 * Returns core cookie settings used for auth token operations.
 * Includes domain from context for proper cookie deletion.
 * @param ctx - Hono context with auth bindings
 * @returns Cookie options with security settings
 */
export function getAuthCookieSettings(ctx: Context): AuthCookieOptions {
	return {
		name: "auth",
		httpOnly: true,
		secure: tokenConfig.cookieSecure,
		sameSite: tokenConfig.cookieSameSite,
		path: "/",
		maxAge: tokenConfig.refreshTokenExpiry,
	};
}
