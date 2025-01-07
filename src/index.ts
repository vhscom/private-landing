import type { Fetcher } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { jwt } from "hono/jwt";
import { handleLogin, handleRegistration } from "./accounts/handler.ts";
import { createDbClient } from "./db.ts";

const app = new Hono<{ Bindings: Env }>();

type ServeStaticOptions = {
	cache: string;
};

function serveStatic(opts: ServeStaticOptions) {
	return createMiddleware<{ Bindings: Env }>(async (ctx, next) => {
		const binding = ctx.env.ASSETS as Fetcher;
		const response = await binding.fetch(
			ctx.req.url,
			/**
			 * Clone raw request and coerce to Cloudflare RequestInit type.
			 * @example
			 * import type {
			 *    RequestInit as CfRequestInit,
			 *    CfProperties,
			 * } from "@cloudflare/workers-types";
			 * ctx.req.raw.clone() as unknown as CfRequestInit<CfProperties>,
			 */
		);

		if (!response.ok) return await next();
		return response as unknown as globalThis.Response;
	});
}

// Public routes (no JWT needed)
app.use("*", serveStatic({ cache: "key" }));
app.post("/api/register", handleRegistration);
app.post("/api/login", handleLogin);

// Then protect everything else under /api/*
app.use("/api/*", async (ctx, next) => {
	if (!ctx.env.COOKIE_SIGNING) {
		throw new Error("Missing cookie signing secret");
	}
	return jwt({
		secret: ctx.env.COOKIE_SIGNING,
		cookie: "__Host-session",
	})(ctx, next);
});

// Protected route - only accessible with valid JWT
app.get("/api/ping", async (ctx) => {
	// Get the JWT payload
	const payload = ctx.get("jwtPayload");

	const dbClient = createDbClient(ctx.env);
	const result = await dbClient.execute("SELECT sqlite_version();");

	return ctx.json({
		message: "Authenticated ping success!",
		userId: payload.userId, // Access claims from the JWT
		version: result,
	});
});

export default app;
