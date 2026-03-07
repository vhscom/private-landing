/**
 * @file proxy.ts
 * Reverse proxy handler for control UI static assets.
 * Proxies successful responses as-is; returns generic 502 on gateway errors.
 * Plugin-only – removable with packages/control (ADR-010).
 *
 * @license Apache-2.0
 */

import type { Context } from "hono";

export async function proxyToGateway(
	ctx: Context,
	gatewayUrl: string,
): Promise<Response> {
	try {
		const target = new URL(ctx.req.url);
		const gateway = new URL(gatewayUrl);
		target.protocol = gateway.protocol;
		target.host = gateway.host;
		target.port = gateway.port;
		target.pathname = target.pathname.replace("/ops/control", "");

		const res = await fetch(target.toString(), ctx.req.raw);

		if (!res.ok) {
			return ctx.json({ error: "Bad Gateway" }, 502);
		}

		return new Response(res.body, {
			status: res.status,
			headers: res.headers,
		});
	} catch {
		return ctx.json({ error: "Bad Gateway" }, 502);
	}
}
