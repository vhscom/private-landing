/**
 * @file app.ts
 * Main application setup with route definitions and middleware configuration.
 *
 * @license Apache-2.0
 */

import {
	createAuthSystem,
	createRequireAuth,
	securityHeaders,
} from "@private-landing/core";
import { createDbClient, serveStatic } from "@private-landing/infrastructure";
import type { Env, Variables } from "@private-landing/types";
import { Hono } from "hono";

// Initialize auth system with factory pattern
const auth = createAuthSystem();

// Create middleware with injected dependencies
const requireAuth = createRequireAuth({
	sessionService: auth.sessions,
	tokenService: auth.tokens,
});

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Global middleware
app.use("*", securityHeaders);
app.use("*", serveStatic({ cache: "key" }));

// Authentication endpoints
app.post("/api/register", async (ctx) => {
	try {
		const body = await ctx.req.parseBody();
		await auth.accounts.createAccount(
			body as { email: string; password: string },
			ctx.env,
		);
		return ctx.redirect("/?registered=true");
	} catch (error: unknown) {
		console.error("Registration error:", error);
		const message =
			error instanceof Error ? error.message : "Registration failed";
		return ctx.redirect(
			`/?error=${encodeURIComponent(message.includes("UNIQUE") ? "Registration failed. Please try again or use a different email address." : message)}`,
		);
	}
});

app.post("/api/login", async (ctx) => {
	try {
		const body = await ctx.req.parseBody();
		const authResult = await auth.accounts.authenticate(
			body as { email: string; password: string },
			ctx.env,
		);

		if (!authResult.authenticated) {
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
});

app.post("/api/logout", requireAuth, async (ctx) => {
	try {
		await auth.sessions.endSession(ctx);
		return ctx.redirect("/?logged_out=true");
	} catch (error) {
		console.error("Logout error:", error);
		const errorMessage =
			error instanceof Error ? error.message : "Logout failed";
		return ctx.redirect(`/?error=${encodeURIComponent(errorMessage)}`);
	}
});

// Protected API routes
app.use("/api/*", requireAuth);
app.get("/api/ping", async (ctx) => {
	const payload = ctx.get("jwtPayload");
	const dbClient = createDbClient(ctx.env);
	const result = await dbClient.execute("SELECT sqlite_version();");

	return ctx.json({
		message: "Authenticated ping success!",
		userId: payload.uid,
		version: result,
	});
});

export default app;
