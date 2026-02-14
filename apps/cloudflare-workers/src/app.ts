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
import {
	createDbClient,
	createValkeyClient,
	serveStatic,
} from "@private-landing/infrastructure";
import {
	type Env,
	ValidationError,
	type Variables,
} from "@private-landing/types";
import { Hono } from "hono";
import { parseRequestBody, wantsJson } from "./utils/negotiate";

// Initialize auth system with factory pattern
const auth = createAuthSystem({ createCacheClient: createValkeyClient });

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
	const json = wantsJson(ctx);
	try {
		const body = await parseRequestBody(ctx);
		await auth.accounts.createAccount(
			body as { email: string; password: string },
			ctx.env,
		);
		if (json) {
			return ctx.json({ success: true, message: "Account created" }, 201);
		}
		return ctx.redirect("/?registered=true");
	} catch (error: unknown) {
		console.error("Registration error:", error);
		if (json) {
			if (error instanceof ValidationError) {
				return ctx.json({ error: error.message, code: error.code }, 400);
			}
			return ctx.json(
				{ error: "Registration failed", code: "REGISTRATION_ERROR" },
				400,
			);
		}
		const message =
			error instanceof ValidationError ? error.message : "Registration failed";
		return ctx.redirect(`/?error=${encodeURIComponent(message)}`);
	}
});

app.post("/api/login", async (ctx) => {
	const json = wantsJson(ctx);
	try {
		const body = await parseRequestBody(ctx);
		const authResult = await auth.accounts.authenticate(
			body as { email: string; password: string },
			ctx.env,
		);

		if (!authResult.authenticated) {
			if (json) {
				return ctx.json(
					{ error: "Authentication failed", code: "INVALID_CREDENTIALS" },
					401,
				);
			}
			return ctx.redirect(
				`/?error=${encodeURIComponent(authResult.error ?? "Authentication failed")}`,
			);
		}

		const sessionId = await auth.sessions.createSession(authResult.userId, ctx);
		await auth.tokens.generateTokens(ctx, authResult.userId, sessionId);

		if (json) {
			return ctx.json({ success: true, message: "Login successful" }, 200);
		}
		return ctx.redirect("/?authenticated=true");
	} catch (error) {
		console.error("Authentication error:", error);
		if (json) {
			return ctx.json(
				{ error: "Authentication failed", code: "INTERNAL_ERROR" },
				500,
			);
		}
		return ctx.redirect("/?error=Authentication failed. Please try again.");
	}
});

app.post("/api/logout", requireAuth, async (ctx) => {
	const json = wantsJson(ctx);
	try {
		await auth.sessions.endSession(ctx);
		if (json) {
			return ctx.json({ success: true, message: "Logged out" }, 200);
		}
		return ctx.redirect("/?logged_out=true");
	} catch (error) {
		console.error("Logout error:", error);
		if (json) {
			return ctx.json({ error: "Logout failed", code: "INTERNAL_ERROR" }, 500);
		}
		const errorMessage =
			error instanceof Error ? error.message : "Logout failed";
		return ctx.redirect(`/?error=${encodeURIComponent(errorMessage)}`);
	}
});

// Protected API routes
app.use("/api/*", requireAuth);

app.get("/api/health", (ctx) => {
	return ctx.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/health/live", (ctx) => {
	return ctx.json({ status: "alive" });
});

app.get("/api/health/ready", async (ctx) => {
	try {
		const dbClient = createDbClient(ctx.env);
		await dbClient.execute("SELECT 1");
		return ctx.json({ status: "ready", database: "reachable" });
	} catch {
		return ctx.json({ status: "not_ready", database: "unreachable" }, 503);
	}
});

app.get("/api/ping", (ctx) => {
	const payload = ctx.get("jwtPayload");
	return ctx.json({ message: "pong", userId: payload.uid });
});

export default app;
