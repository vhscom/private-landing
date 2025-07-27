/**
 * @file auth-handlers.ts
 * Example request handlers demonstrating core auth flows.
 * Shows minimal implementation of authentication, registration, and session management.
 *
 * Features:
 * - Login with session creation
 * - Secure logout handling
 * - User registration with validation
 * - Error handling with user feedback
 *
 * @license Apache-2.0
 */

import { createAuthSystem } from "@private-landing/core";
import { ValidationError } from "@private-landing/errors";
import type { LoginInput, RegistrationInput } from "@private-landing/schemas";
import type { AuthResult, AuthenticatedState } from "@private-landing/types";
import type { Context } from "hono";

// Initialize auth system with default configuration
const auth = createAuthSystem();

/**
 * Type guard for successful authentication results.
 * Enables type-safe handling of auth responses.
 *
 * @param result - Authentication result to check
 * @returns Type predicate for authenticated state with userId
 */
const isAuthenticated = (result: AuthResult): result is AuthenticatedState =>
	result.authenticated;

/**
 * Example login handler showing complete authentication flow.
 * Demonstrates credential validation, session creation, and token generation.
 *
 * @param ctx - Hono context containing request and environment
 * @returns Redirect response with success or error message
 * @throws Never - All errors are caught and converted to redirects
 */
export async function handleLogin(ctx: Context) {
	try {
		const body = await ctx.req.parseBody();
		const authResult = await auth.accounts.authenticate(
			body as LoginInput,
			ctx.env,
		);

		if (!isAuthenticated(authResult)) {
			return ctx.redirect(
				`/?error=${encodeURIComponent(authResult.error ?? "Authentication failed")}`,
			);
		}

		const sessionId = await auth.sessions.createSession(authResult.userId, ctx);
		await auth.tokens.generateTokens(ctx, authResult.userId, sessionId);

		return ctx.redirect("/?authenticated=true");
	} catch (error) {
		console.error("Authentication error:", error);
		return ctx.redirect("/?error=Authentication failed. Please try again.");
	}
}

/**
 * Example logout handler showing session cleanup.
 * Demonstrates proper session termination and cookie removal.
 *
 * @param ctx - Hono context containing request and environment
 * @returns Redirect response with success or error message
 */
export async function handleLogout(ctx: Context) {
	try {
		await auth.sessions.endSession(ctx);
		return ctx.redirect("/?logged_out=true");
	} catch (error) {
		console.error("Logout error:", error);
		const errorMessage =
			error instanceof Error ? error.message : "Logout failed";
		return ctx.redirect(`/?error=${encodeURIComponent(errorMessage)}`);
	}
}

/**
 * Example registration handler showing account creation.
 * Demonstrates input validation and error handling.
 *
 * @param ctx - Hono context containing request and environment
 * @returns Redirect response with success or error message
 */
export async function handleRegistration(ctx: Context) {
	try {
		const body = await ctx.req.parseBody();
		await auth.accounts.createAccount(body as RegistrationInput, ctx.env);
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
