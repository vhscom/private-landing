/**
 * @file proxy.ts
 * Reverse proxy handler for control UI static assets.
 * Proxies successful responses as-is; returns generic 502 on gateway errors.
 * Plugin-only – removable with packages/control (ADR-010).
 *
 * @license Apache-2.0
 */

import type { Context } from "hono";
import { isSafeGatewayUrl } from "./types";

export async function proxyToGateway(
	ctx: Context,
	gatewayUrl: string,
): Promise<Response> {
	try {
		if (
			!isSafeGatewayUrl(
				gatewayUrl,
				(ctx.env as { ENVIRONMENT?: string } | undefined)?.ENVIRONMENT,
			)
		) {
			return ctx.json({ error: "Bad Gateway" }, 502);
		}

		const target = new URL(ctx.req.url);
		const gateway = new URL(gatewayUrl);
		target.protocol = gateway.protocol;
		target.host = gateway.host;
		target.port = gateway.port;
		// Strip /ops/control prefix; also strip /ops for bare /ops/assets/* requests
		target.pathname = target.pathname.startsWith("/ops/control")
			? target.pathname.replace("/ops/control", "")
			: target.pathname.replace(/^\/ops\//, "/");

		const headers = new Headers(ctx.req.raw.headers);
		headers.delete("cookie");
		headers.delete("authorization");

		const res = await fetch(target.toString(), {
			method: ctx.req.method,
			headers,
			body: ctx.req.raw.body,
			redirect: "manual",
		});

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
