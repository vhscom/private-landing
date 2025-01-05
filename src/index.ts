import type { Fetcher } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
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

app.use("*", serveStatic({ cache: "key" }));

app.post("/api/register", handleRegistration);
app.post("/api/login", handleLogin);

app.use("/ping", async (ctx) => {
	const dbClient = createDbClient(ctx.env);
	const result = await dbClient.execute("SELECT sqlite_version();");
	if (ctx.error) {
		console.error("Database error:", ctx.error.name);
		return ctx.json({ error: ctx.error });
	}
	return ctx.json(result);
});

export default app;
