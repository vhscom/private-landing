/**
 * @file token-config.ts
 * Configuration for JWT token management and authentication.
 *
 * @license Apache-2.0
 */

import type { TokenConfig } from "@private-landing/types";

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
