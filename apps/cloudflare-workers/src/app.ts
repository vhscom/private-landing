/**
 * @file app.ts
 * Main application setup with route definitions and middleware configuration.
 *
 * @license LGPL-3.0-or-later
 */

import {
	getServiceContainer,
	requireAuth,
	securityHeaders,
	tokenService,
} from "@private-landing/core";
import { createDbClient, serveStatic } from "@private-landing/infrastructure";
import type { Env, Variables } from "@private-landing/types";
import { Hono } from "hono";
import {
	handleLogin,
	handleLogout,
	handleRegistration,
} from "./handlers/auth-handlers";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Initialize services at startup
const container = getServiceContainer();
container.initializeServices();

// Global middleware
app.use("*", securityHeaders);
app.use("*", serveStatic({ cache: "key" }));

// Authentication endpoints
app.post("/api/register", handleRegistration);
app.post("/api/login", async (ctx) => {
	const sessionService = container.getService("sessionService");
	const result = await handleLogin(ctx);

	const isAuthenticated =
		result.status === 302 &&
		result.headers.get("Location")?.includes("authenticated=true");

	if (isAuthenticated) {
		const session = await sessionService.getSession(ctx);
		if (session?.userId) {
			await tokenService.generateTokens(ctx, session.userId, session.id);
		}
	}

	return result;
});
app.post("/api/logout", requireAuth, handleLogout);

// Protected API routes
app.use("/api/*", requireAuth);
app.get("/api/ping", async (ctx) => {
	const payload = ctx.get("jwtPayload");
	const dbClient = createDbClient(ctx.env);
	const result = await dbClient.execute("SELECT sqlite_version();");

	return ctx.json({
		message: "Authenticated ping success!",
		userId: payload.user_id,
		version: result,
	});
});

export default app;
