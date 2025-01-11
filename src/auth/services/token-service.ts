import type { Context } from "hono";
import { sign } from "hono/jwt";
import { type TokenPayload, tokenConfig } from "../config/token-config.ts";
import { setSecureCookie } from "../utils/cookie.ts";

export const tokenService = {
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
