/**
 * @file require-auth.ts
 * Authentication middleware that validates JWT tokens and sessions.
 * Uses refresh token to automatically renew expired access tokens.
 *
 * @license LGPL-3.0-or-later
 * @see ADR-001 for authentication design
 */

import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { verify } from "hono/jwt";
import { getSession } from "../services/session-service.ts";
import { tokenService } from "../services/token-service.ts";
import type { TokenPayload } from "../types/auth.types.ts";
import type { AuthContext, Variables } from "../types/context.ts";

/**
 * Authentication middleware that validates JWT tokens and sessions.
 * Uses refresh token to automatically renew expired access tokens.
 *
 * @see ADR-001 for authentication design
 */
export const requireAuth = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (ctx, next) => {
	try {
		// First attempt: Validate existing access token if present
		const accessToken = getCookie(ctx, "access_token");
		if (accessToken) {
			try {
				const payload = await verifyToken(ctx, accessToken, "access");
				if (await isValidSession(ctx, payload)) {
					return next();
				}
			} catch {
				// Access token is invalid or expired - proceed to refresh flow
			}
		}

		// Second attempt: Try refresh token flow
		const refreshToken = getCookie(ctx, "refresh_token");
		if (!refreshToken) {
			return ctx.json({ error: "Authentication required" }, 401);
		}

		const refreshPayload = await verifyToken(ctx, refreshToken, "refresh");
		if (!(await isValidSession(ctx, refreshPayload))) {
			return ctx.json({ error: "Invalid session" }, 401);
		}

		// Generate and verify new access token
		const newAccessToken = await tokenService.refreshAccessToken(
			ctx,
			refreshPayload,
		);
		await verifyToken(ctx, newAccessToken, "access");

		return next();
	} catch (error) {
		console.error("Auth error:", error);
		return ctx.json({ error: "Authentication failed" }, 401);
	}
});

/**
 * Verifies a JWT token and ensures it matches the expected type.
 * Also sets the payload in the context for downstream middleware/handlers.
 *
 * @param ctx - Hono context with auth bindings
 * @param token - JWT token to verify
 * @param type - Expected token type
 * @returns The verified token payload
 * @throws Error if token is invalid or of wrong type
 */
async function verifyToken(
	ctx: AuthContext,
	token: string,
	type: "access" | "refresh",
) {
	const secret =
		type === "access" ? ctx.env.JWT_ACCESS_SECRET : ctx.env.JWT_REFRESH_SECRET;
	const payload = (await verify(token, secret)) as TokenPayload;

	if (payload.typ !== type) {
		throw new Error("Invalid token type");
	}

	ctx.set("jwtPayload", payload);
	return payload;
}

/**
 * Validates that a session exists and matches the token's session ID.
 * Used to ensure tokens can't be used after a logout/session invalidation.
 *
 * @param ctx - Hono context with auth bindings
 * @param payload - The verified token payload
 * @returns True if session is valid, false otherwise
 */
async function isValidSession(
	ctx: AuthContext,
	payload: TokenPayload,
): Promise<boolean> {
	const session = await getSession(ctx);
	return session?.id === payload.sid;
}
