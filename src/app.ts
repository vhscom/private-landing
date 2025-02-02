/**
 * @file app.ts
 * Main application setup with route definitions and middleware configuration.
 *
 * @license LGPL-3.0-or-later
 */

import { Hono } from "hono";
import {
	handleLogin,
	handleLogout,
	handleRegistration,
} from "./account/handlers/auth-handlers.ts";
import { requireAuth } from "./auth/middleware/require-auth.ts";
import { securityHeaders } from "./auth/middleware/security.ts";
import { getSession } from "./auth/services/session-service.ts";
import { tokenService } from "./auth/services/token-service.ts";
import type { Variables } from "./auth/types/context.ts";
import { createDbClient } from "./infrastructure/db/client.ts";
import { serveStatic } from "./infrastructure/middleware/serve-static.ts";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Global middleware
app.use("*", securityHeaders);
app.use("*", serveStatic({ cache: "key" }));

// Authentication endpoints
app.post("/api/register", handleRegistration);
app.post("/api/login", async (ctx) => {
	const result = await handleLogin(ctx);

	const isAuthenticated =
		result.status === 302 &&
		result.headers.get("Location")?.includes("authenticated=true");

	if (isAuthenticated) {
		const session = await getSession(ctx);
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
