import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { verify } from "hono/jwt";
import type { TokenPayload } from "../config/token-config.ts";
import { getSession } from "../services/session-service.ts";
import { tokenService } from "../services/token-service.ts";

// Extend variables to include JWT payload
export type Variables = {
	jwtPayload: TokenPayload;
};

// Authentication middleware that verifies access tokens
export const requireAuth = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (ctx, next) => {
	try {
		// Check for access token
		const accessToken = getCookie(ctx, "access_token");
		if (!accessToken) {
			return ctx.json({ error: "No access token provided" }, 401);
		}

		// Verify access token
		try {
			const payload = (await verify(
				accessToken,
				ctx.env.JWT_ACCESS_SECRET,
			)) as TokenPayload;

			if (payload.typ !== "access") {
				return ctx.json({ error: "Invalid token type" }, 401);
			}

			// Set payload in context before session check
			ctx.set("jwtPayload", payload);

			// Verify session still exists and is valid
			const session = await getSession(ctx);
			if (!session || session.id !== payload.sid) {
				return ctx.json({ error: "Invalid session" }, 401);
			}

			return await next();
		} catch (error) {
			// Try to refresh the access token
			const refreshToken = getCookie(ctx, "refresh_token");
			if (!refreshToken) {
				return ctx.json(
					{ error: "Access token expired and no refresh token present" },
					401,
				);
			}

			try {
				// Verify refresh token
				const refreshPayload = (await verify(
					refreshToken,
					ctx.env.JWT_REFRESH_SECRET,
				)) as TokenPayload;

				if (refreshPayload.typ !== "refresh") {
					return ctx.json({ error: "Invalid refresh token type" }, 401);
				}

				// Set refresh payload in context before session check
				ctx.set("jwtPayload", refreshPayload);

				// Verify session still exists and is valid
				const session = await getSession(ctx);
				if (!session || session.id !== refreshPayload.sid) {
					return ctx.json({ error: "Invalid session" }, 401);
				}

				// Generate new access token
				const newAccessToken = await tokenService.refreshAccessToken(
					ctx,
					refreshPayload,
				);

				// Update context with new access token payload
				const newPayload = await verify(
					newAccessToken,
					ctx.env.JWT_ACCESS_SECRET,
				);
				ctx.set("jwtPayload", newPayload);

				return await next();
			} catch {
				return ctx.json({ error: "Invalid or expired refresh token" }, 401);
			}
		}
	} catch (error) {
		console.error("Auth middleware error:", error);
		return ctx.json({ error: "Authentication failed" }, 401);
	}
});
