import type { Fetcher } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
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

app.post("/api/register", async (ctx) => {
	const body = await ctx.req.parseBody();
	console.log("Received registration request:", body);
	return ctx.redirect('/?registered=true');
	// return ctx.json({
	// 	email: body.email,
	// 	success: true,
	// });
});

app.use("/users", async (ctx) => {
	const dbClient = createDbClient(ctx.env);
	try {
		const result = await dbClient.execute("SELECT sqlite_version();");
		return ctx.json(result);
	} catch (err) {
		console.error("Database error:", err);
		return ctx.json({ error: "Internal Server Error" }, 500);
	}
});

export default app;
