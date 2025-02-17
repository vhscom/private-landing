/**
 * @file token-service.ts
 * Handles JWT token generation and management for user authentication.
 * Implements access and refresh token pattern with secure cookie storage.
 * @license LGPL-3.0-or-later
 */

import type { TokenPayload } from "@private-landing/types";
import type { Context } from "hono";
import { sign } from "hono/jwt";
import { tokenConfig } from "../config";
import { setSecureCookie } from "../utils/cookie";

/**
 * Service object containing methods for JWT token management.
 * Handles both access and refresh tokens with secure cookie implementation.
 */
export const tokenService = {
	/**
	 * Generates a pair of JWT tokens (access and refresh) for an authenticated user.
	 * Sets both tokens as secure HTTP-only cookies and returns them.
	 *
	 * @param ctx - Hono context containing request and environment
	 * @param user_id - The authenticated user's ID
	 * @param session_id - The current session ID
	 * @throws Error if JWT signing secrets are not configured
	 * @returns Promise resolving to object containing both token strings
	 */
	generateTokens: async (ctx: Context, user_id: number, session_id: string) => {
		if (!ctx.env.JWT_ACCESS_SECRET || !ctx.env.JWT_REFRESH_SECRET) {
			throw new Error("Missing token signing secrets");
		}

		// Generate refresh token
		const refreshPayload: TokenPayload = {
			uid: user_id,
			sid: session_id,
			typ: "refresh",
			exp: Math.floor(Date.now() / 1000) + tokenConfig.refreshTokenExpiry,
		};

		const refreshToken = await sign(refreshPayload, ctx.env.JWT_REFRESH_SECRET);

		// Generate access token
		const accessPayload: TokenPayload = {
			uid: user_id,
			sid: session_id,
			typ: "access",
			exp: Math.floor(Date.now() / 1000) + tokenConfig.accessTokenExpiry,
		};

		const accessToken = await sign(accessPayload, ctx.env.JWT_ACCESS_SECRET);

		// Set cookies
		setSecureCookie(
			ctx,
			"refresh_token",
			refreshToken,
			tokenConfig.refreshTokenExpiry,
		);
		setSecureCookie(
			ctx,
			"access_token",
			accessToken,
			tokenConfig.accessTokenExpiry,
		);

		return { accessToken, refreshToken };
	},

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
	refreshAccessToken: async (ctx: Context, payload: TokenPayload) => {
		if (!ctx.env.JWT_ACCESS_SECRET) {
			throw new Error("Missing access token signing secret");
		}

		// Generate new access token with same session_id
		const accessPayload: TokenPayload = {
			uid: payload.uid,
			sid: payload.sid,
			typ: "access",
			exp: Math.floor(Date.now() / 1000) + tokenConfig.accessTokenExpiry,
		};

		const accessToken = await sign(accessPayload, ctx.env.JWT_ACCESS_SECRET);

		// Set new access token cookie
		setSecureCookie(
			ctx,
			"access_token",
			accessToken,
			tokenConfig.accessTokenExpiry,
		);

		return accessToken;
	},
};
