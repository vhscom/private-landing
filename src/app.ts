import { Hono } from "hono";
import {
	handleLogin,
	handleRegistration,
} from "./account/handlers/auth-handlers.ts";
import { rateLimitConfig } from "./auth/config/rate-limit-config";
import { createRateLimit } from "./auth/middleware/rate-limit.ts";
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

// Dev routes (only in development)
if (process.env.NODE_ENV !== "production") {
	app.get("/test/rate-limit", createRateLimit(rateLimitConfig.login), (ctx) => {
		return ctx.json({ message: "Rate limit test successful" });
	});

	app.get("/test/auth", requireAuth, (ctx) => {
		return ctx.json({ message: "Auth test successful" });
	});
}

// Public auth endpoints (rate limited)
app.post(
	"/api/register",
	createRateLimit(rateLimitConfig.login),
	handleRegistration,
);
app.post("/api/login", createRateLimit(rateLimitConfig.login), async (ctx) => {
	const result = await handleLogin(ctx);

	const isAuthenticated =
		result.status === 302 &&
		result.headers.get("Location")?.includes("authenticated=true");

	if (isAuthenticated) {
		const session = await getSession(ctx);
		if (session?.user_id) {
			await tokenService.generateTokens(ctx, session.user_id, session.id);
		}
	}

	return result;
});

// Token refresh endpoint (specially rate limited)
const refresh = new Hono<{ Bindings: Env; Variables: Variables }>();
refresh.use("*", createRateLimit(rateLimitConfig.refresh));
refresh.use("*", requireAuth);
app.route("/api/refresh", refresh);

// All other protected routes
const api = new Hono<{ Bindings: Env; Variables: Variables }>();
api.use("*", requireAuth);

api.get("/ping", async (ctx) => {
	const payload = ctx.get("jwtPayload");
	const dbClient = createDbClient(ctx.env);
	const result = await dbClient.execute("SELECT sqlite_version();");

	return ctx.json({
		message: "Authenticated ping success!",
		userId: payload.user_id,
		version: result,
	});
});

app.route("/api", api);

// Default route handler
app.get("*", (ctx) => {
	return ctx.json({ error: "Not Found" }, 404);
});

export default app;
