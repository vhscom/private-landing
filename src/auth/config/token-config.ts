/**
 * @file token-config.ts
 * Configuration for JWT token management and authentication.
 *
 * @license LGPL-3.0-or-later
 */

import type { TokenConfig } from "../types/auth.types.ts";

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
