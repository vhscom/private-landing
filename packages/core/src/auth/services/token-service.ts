/**
 * @file token-service.ts
 * Handles JWT token generation and management for user authentication.
 * Implements access and refresh token pattern with secure cookie storage.
 * @license Apache-2.0
 */

import type { TokenConfig, TokenPayload } from "@private-landing/types";
import type { Context } from "hono";
import { sign } from "hono/jwt";
import { tokenConfig as defaultTokenConfig } from "../config";
import { setSecureCookie } from "../utils/cookie";

/**
 * Interface defining the token service API.
 * Provides methods for JWT token generation and refresh.
 */
export interface TokenService {
	/**
	 * Generates a pair of JWT tokens (access and refresh) for an authenticated user.
	 * Sets both tokens as secure HTTP-only cookies and returns them.
	 *
	 * @param ctx - Hono context containing request and environment
	 * @param userId - The authenticated user's ID
	 * @param sessionId - The current session ID
	 * @throws Error if JWT signing secrets are not configured
	 * @returns Promise resolving to object containing both token strings
	 */
	generateTokens(
		ctx: Context,
		userId: number,
		sessionId: string,
	): Promise<{ accessToken: string; refreshToken: string }>;

	/**
	 * Generates a new access token using an existing refresh token's payload.
	 * Maintains the same session ID while creating a new expiration time.
	 * Sets the new access token as a secure HTTP-only cookie.
	 *
	 * @param ctx - Hono context containing request and environment
	 * @param payload - The payload from the existing refresh token
	 * @throws Error if access token signing secret is not configured
	 * @returns Promise resolving to the new access token string
	 */
	refreshAccessToken(ctx: Context, payload: TokenPayload): Promise<string>;
}

/**
 * Configuration options for token service.
 */
export interface TokenServiceConfig extends Partial<TokenConfig> {}

/**
 * Creates a configured token management service.
 * Provides methods for JWT token generation and refresh
 * with secure cookie implementation.
 *
 * @param config - Configuration for token expiry and cookie settings
 * @returns Token management service with generate/refresh operations
 */
export function createTokenService(
	config: TokenServiceConfig = {},
): TokenService {
	const resolvedConfig: TokenConfig = { ...defaultTokenConfig, ...config };

	return {
		async generateTokens(
			ctx: Context,
			userId: number,
			sessionId: string,
		): Promise<{ accessToken: string; refreshToken: string }> {
			if (!ctx.env.JWT_ACCESS_SECRET || !ctx.env.JWT_REFRESH_SECRET) {
				throw new Error("Missing token signing secrets");
			}

			// Generate refresh token
			const refreshPayload: TokenPayload = {
				uid: userId,
				sid: sessionId,
				typ: "refresh",
				exp: Math.floor(Date.now() / 1000) + resolvedConfig.refreshTokenExpiry,
			};

			const refreshToken = await sign(
				refreshPayload,
				ctx.env.JWT_REFRESH_SECRET,
			);

			// Generate access token
			const accessPayload: TokenPayload = {
				uid: userId,
				sid: sessionId,
				typ: "access",
				exp: Math.floor(Date.now() / 1000) + resolvedConfig.accessTokenExpiry,
			};

			const accessToken = await sign(accessPayload, ctx.env.JWT_ACCESS_SECRET);

			// Set cookies
			setSecureCookie(
				ctx,
				"refresh_token",
				refreshToken,
				resolvedConfig.refreshTokenExpiry,
			);
			setSecureCookie(
				ctx,
				"access_token",
				accessToken,
				resolvedConfig.accessTokenExpiry,
			);

			return { accessToken, refreshToken };
		},

		async refreshAccessToken(
			ctx: Context,
			payload: TokenPayload,
		): Promise<string> {
			if (!ctx.env.JWT_ACCESS_SECRET) {
				throw new Error("Missing access token signing secret");
			}

			// Generate new access token with same session_id
			const accessPayload: TokenPayload = {
				uid: payload.uid,
				sid: payload.sid,
				typ: "access",
				exp: Math.floor(Date.now() / 1000) + resolvedConfig.accessTokenExpiry,
			};

			const accessToken = await sign(accessPayload, ctx.env.JWT_ACCESS_SECRET);

			// Set new access token cookie
			setSecureCookie(
				ctx,
				"access_token",
				accessToken,
				resolvedConfig.accessTokenExpiry,
			);

			return accessToken;
		},
	};
}

// Export a default instance for convenience (maintains backward compatibility)
export const tokenService = createTokenService();
