/**
 * @file require-auth.ts
 * Authentication middleware that validates JWT tokens and sessions.
 * Uses refresh token to automatically renew expired access tokens.
 *
 * @license Apache-2.0
 * @see ADR-001 for authentication design
 */

import type {
	AuthContext,
	Env,
	TokenPayload,
	Variables,
} from "@private-landing/types";
import {
	AuthenticationError,
	SessionError,
	TokenError,
} from "@private-landing/types";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { HTTPException } from "hono/http-exception";
import { verify } from "hono/jwt";
import type { MiddlewareHandler } from "hono/types";
import type { SessionService } from "../services/session-service";
import type { TokenService } from "../services/token-service";

/**
 * Dependencies required for the auth middleware.
 */
export interface RequireAuthDeps {
	sessionService: SessionService;
	tokenService: TokenService;
}

/**
 * Creates authentication middleware with injected dependencies.
 * Validates JWT tokens and sessions, with automatic token refresh.
 *
 * @param deps - Session and token services for auth operations
 * @returns Configured authentication middleware
 * @see ADR-001 for authentication design
 */
export function createRequireAuth(
	deps: RequireAuthDeps,
): MiddlewareHandler<{ Bindings: Env; Variables: Variables }> {
	const { sessionService, tokenService } = deps;

	/**
	 * Validates that a session exists and matches the token's session ID.
	 * Used to ensure tokens can't be used after a logout/session invalidation.
	 */
	async function isValidSession(
		ctx: AuthContext,
		payload: TokenPayload,
	): Promise<boolean> {
		const session = await sessionService.getSession(ctx);
		return session?.id === payload.sid;
	}

	return createMiddleware<{
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
				throw TokenError.expired(
					"Access token expired and no refresh token present",
				);
			}

			const refreshPayload = await verifyToken(ctx, refreshToken, "refresh");
			if (!(await isValidSession(ctx, refreshPayload))) {
				throw SessionError.revoked();
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
			if (error instanceof AuthenticationError) {
				return ctx.json(
					{
						error: error.message,
						code: error.code,
					},
					error.statusCode as HTTPException["status"],
				);
			}
			return ctx.json(
				{
					error: "Authentication failed",
					code: "UNKNOWN_ERROR",
				},
				401 as HTTPException["status"],
			);
		}
	});
}

/**
 * Verifies a JWT token and ensures it matches the expected type.
 * Also sets the payload in the context for downstream middleware/handlers.
 *
 * @param ctx - Hono context with auth bindings
 * @param token - JWT token to verify
 * @param type - Expected token type
 * @returns The verified token payload
 * @throws TokenError if token is invalid, malformed, or of wrong type
 */
async function verifyToken(
	ctx: AuthContext,
	token: string,
	type: "access" | "refresh",
): Promise<TokenPayload> {
	try {
		const secret =
			type === "access"
				? ctx.env.JWT_ACCESS_SECRET
				: ctx.env.JWT_REFRESH_SECRET;
		const payload = (await verify(token, secret)) as TokenPayload;

		if (payload.typ !== type) {
			throw TokenError.malformed("Invalid token type");
		}

		ctx.set("jwtPayload", payload);
		return payload;
	} catch (error) {
		if (error instanceof TokenError) {
			throw error;
		}
		// Handle JWT verification errors from hono/jwt
		throw TokenError.malformed("Invalid token structure");
	}
}
