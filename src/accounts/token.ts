import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import { sign } from "hono/jwt";

interface TokenConfig {
	accessTokenExpiry: number; // seconds
	refreshTokenExpiry: number; // seconds
	cookieSecure: boolean;
	cookieSameSite: "Strict" | "Lax" | "None";
}

export interface TokenPayload {
	user_id: number;
	session_id: string;
	type: "access" | "refresh";
	exp?: number;
	[key: string]: string | number | undefined; // Index signature for JWT compatibility
}

const tokenConfig: TokenConfig = {
	accessTokenExpiry: 15 * 60, // 15 minutes
	refreshTokenExpiry: 7 * 24 * 3600, // 7 days
	cookieSecure: true,
	cookieSameSite: "Strict",
};

/**
 * Sets a secure cookie with the JWT token.
 */
function setSecureCookie(
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

export const tokenService = {
	generateTokens: async (ctx: Context, user_id: number, session_id: string) => {
		if (!ctx.env.JWT_ACCESS_SECRET || !ctx.env.JWT_REFRESH_SECRET) {
			throw new Error("Missing token signing secrets");
		}

		// Generate refresh token
		const refreshPayload: TokenPayload = {
			user_id,
			session_id,
			type: "refresh",
			exp: Math.floor(Date.now() / 1000) + tokenConfig.refreshTokenExpiry,
		};

		const refreshToken = await sign(refreshPayload, ctx.env.JWT_REFRESH_SECRET);

		// Generate access token
		const accessPayload: TokenPayload = {
			user_id,
			session_id,
			type: "access",
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

	refreshAccessToken: async (ctx: Context, payload: TokenPayload) => {
		if (!ctx.env.JWT_ACCESS_SECRET) {
			throw new Error("Missing access token signing secret");
		}

		// Generate new access token with same session_id
		const accessPayload: TokenPayload = {
			user_id: payload.user_id,
			session_id: payload.session_id,
			type: "access",
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
