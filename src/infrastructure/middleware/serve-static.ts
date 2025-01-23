/**
 * @file serve-static.ts
 * Middleware for serving static assets through Cloudflare Workers.
 *
 * @license LGPL-3.0-or-later
 */

import type { Fetcher } from "@cloudflare/workers-types";
import { createMiddleware } from "hono/factory";

export type ServeStaticOptions = {
	cache: string;
};

export function serveStatic(_opts: ServeStaticOptions) {
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
