/**
 * @file negotiate.ts
 * Content negotiation utilities for returning JSON or redirect responses.
 *
 * @license Apache-2.0
 */

import type { Context } from "hono";

/**
 * Checks whether the client explicitly accepts JSON responses.
 * Returns false for wildcard Accept headers (`*\/*`) — only explicit
 * `application/json` triggers JSON mode.
 */
export function wantsJson(ctx: Context): boolean {
	const accept = ctx.req.header("Accept") ?? "";
	return accept.includes("application/json");
}

/**
 * Parses the request body as JSON or form data based on Content-Type.
 * Returns a plain object with string values suitable for auth handlers.
 */
export async function parseRequestBody(
	ctx: Context,
): Promise<Record<string, string>> {
	const contentType = ctx.req.header("Content-Type") ?? "";

	if (contentType.includes("application/json")) {
		return (await ctx.req.json()) as Record<string, string>;
	}

	const formData = await ctx.req.parseBody();
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(formData)) {
		if (typeof value === "string") {
			result[key] = value;
		}
	}
	return result;
}
