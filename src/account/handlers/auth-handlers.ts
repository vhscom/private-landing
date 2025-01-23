import type { Context } from "hono";
import { createSession, endSession } from "../../auth/services/session-service";
import { tokenService } from "../../auth/services/token-service";
import { accountService } from "../services/account-service";

/**
 * Handles user login requests.
 * Authenticates credentials, creates a session, and sets auth tokens.
 *
 * @param ctx - Hono context containing request and environment
 * @returns Redirect response with success or error message
 */
export async function handleLogin(ctx: Context) {
	try {
		const body = await ctx.req.parseBody();
		const { email, password } = body;

		const authResult = await accountService.authenticate(
			email as string,
			password as string,
			ctx.env,
		);

		if (!authResult.authenticated) {
			return ctx.redirect("/?error=Invalid email or password");
		}

		if (authResult.userId) {
			const sessionId = await createSession(authResult.userId, ctx);
			await tokenService.generateTokens(ctx, authResult.userId, sessionId);
		}

		return ctx.redirect("/?authenticated=true");
	} catch (error) {
		console.error("Authentication error:", error);
		return ctx.redirect("/?error=Authentication failed. Please try again.");
	}
}

/**
 * Handles user logout requests.
 * Invalidates the current session and clears auth cookies.
 *
 * @param ctx - Hono context containing request and environment
 * @returns Redirect response with success or error message
 */
export async function handleLogout(ctx: Context) {
	try {
		await endSession(ctx);
		return ctx.redirect("/?logged_out=true");
	} catch (error) {
		console.error("Logout error:", error);
		const errorMessage =
			error instanceof Error ? error.message : "Logout failed";
		return ctx.redirect(`/?error=${encodeURIComponent(errorMessage)}`);
	}
}

/**
 * Handles new user registration requests.
 * Creates account with secure password storage and validation.
 *
 * @param ctx - Hono context containing request and environment
 * @returns Redirect response with success or validation error message
 * @throws {ValidationError} If password requirements not met
 */
export async function handleRegistration(ctx: Context) {
	try {
		const body = await ctx.req.parseBody();
		const { email, password } = body;
		await accountService.createAccount(
			email as string,
			password as string,
			ctx.env,
		);
		return ctx.redirect("/?registered=true");
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "VALIDATION_ERROR"
		) {
			const errorMessage =
				error instanceof Error ? error.message : "Validation failed.";
			return ctx.redirect(`/?error=${encodeURIComponent(errorMessage)}`);
		}
		console.error("Registration error:", error);
		const errorMessage =
			error instanceof Error
				? error.message
				: "Registration failed. Please try again.";
		return ctx.redirect(`/?error=${encodeURIComponent(errorMessage)}`);
	}
}
