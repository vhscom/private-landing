/**
 * @file auth-handlers.ts
 * Request handlers for user authentication, registration, and session management.
 *
 * @license LGPL-3.0-or-later
 */

import type { Context } from "hono";
import type {
	LoginInput,
	RegistrationInput,
} from "../../auth/schemas/auth.schema.ts";
import { createSession, endSession } from "../../auth/services/session-service";
import { tokenService } from "../../auth/services/token-service";
import { ValidationError } from "../../auth/utils/errors.ts";
import { accountService } from "../services/account-service";

/**
 * Handles user login requests.
 * Routes login credentials to account service for validation and authentication.
 * Creates session and sets tokens upon successful authentication.
 *
 * @param ctx - Hono context containing request and environment
 * @returns Redirect response with success or error message
 */
export async function handleLogin(ctx: Context) {
	try {
		const body = await ctx.req.parseBody();
		const authResult = await accountService.authenticate(
			body as LoginInput,
			ctx.env,
		);

		if (!authResult.authenticated) {
			return ctx.redirect(
				`/?error=${encodeURIComponent(authResult.error ?? "Authentication failed")}`,
			);
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
 * Routes registration data to account service for validation and account creation.
 *
 * @param ctx - Hono context containing request and environment
 * @returns Redirect response with success or error message
 */
export async function handleRegistration(ctx: Context) {
	try {
		const body = await ctx.req.parseBody();
		await accountService.createAccount(body as RegistrationInput, ctx.env);
		return ctx.redirect("/?registered=true");
	} catch (error) {
		if (error instanceof ValidationError) {
			return ctx.redirect(`/?error=${encodeURIComponent(error.message)}`);
		}
		console.error("Registration error: ", error);
		const errorMessage =
			error instanceof Error
				? error.message
				: "Registration failed. Please try again.";
		return ctx.redirect(`/?error=${encodeURIComponent(errorMessage)}`);
	}
}
