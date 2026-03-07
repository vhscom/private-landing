/**
 * @file index.ts
 * Public API for the control bridge plugin (ADR-010).
 * Layers on top of packages/observability — requires opsRouter from observabilityPlugin().
 * Plugin-only – removable by deleting packages/control and commenting mount line in app.ts.
 *
 * @license Apache-2.0
 */

import { upgradeWebSocket } from "@private-landing/observability";
import type { Env, GetClientIpFn } from "@private-landing/types";
import type { Hono } from "hono";
import type { MiddlewareHandler } from "hono/types";
import { createBridgeHandler } from "./bridge/handler";
import type { BridgePrincipal } from "./bridge/types";
import { createIpAllowlist } from "./middleware/ip-allowlist";
import { userOneGuard } from "./middleware/user-one-guard";
import { proxyToGateway } from "./proxy";
import type { ControlBindings } from "./types";

export interface ControlPluginDeps {
	requireAuth: MiddlewareHandler;
	obsEmitEvent?: (
		ctx: {
			req: { url: string; header: (name: string) => string | undefined };
			env: Env;
			executionCtx?: { waitUntil(promise: Promise<unknown>): void };
		},
		event: { type: string; userId?: number; detail?: Record<string, unknown> },
	) => void;
	getClientIp?: GetClientIpFn;
}

/**
 * Mount control bridge routes on the ops router.
 * Call after observabilityPlugin() in app.ts:
 * `controlPlugin(opsRouter, { requireAuth, obsEmitEvent })`
 */
export function controlPlugin(
	// biome-ignore lint/suspicious/noExplicitAny: accepts any ops router shape
	opsRouter: Hono<any>,
	deps: ControlPluginDeps,
): void {
	const ipAllowlist = createIpAllowlist(deps.getClientIp);

	// Static asset reverse proxy
	opsRouter.all(
		"/control/*",
		deps.requireAuth,
		userOneGuard,
		ipAllowlist,
		async (ctx) => {
			const gatewayUrl = (ctx.env as ControlBindings).GATEWAY_URL;
			if (!gatewayUrl) {
				return ctx.notFound();
			}

			deps.obsEmitEvent?.(ctx, {
				type: "control.proxy",
				detail: { path: ctx.req.path, method: ctx.req.method },
			});

			return proxyToGateway(ctx, gatewayUrl);
		},
	);

	// WebSocket bridge (ADR-010 §WebSocket Bridge)
	opsRouter.get(
		"/ws",
		deps.requireAuth,
		userOneGuard,
		ipAllowlist,
		upgradeWebSocket((ctx) => {
			const env = ctx.env as ControlBindings;
			if (!env.GATEWAY_URL || !env.GATEWAY_TOKEN) {
				// Cannot upgrade — gateway not configured
				throw new Error("Gateway not configured");
			}

			const payload = ctx.get("jwtPayload") as {
				uid: number;
				sid: string;
			};

			const principal: BridgePrincipal = {
				id: `user:${payload.uid}`,
				name: `user-${payload.uid}`,
				trustLevel: "admin",
				uid: payload.uid,
				sid: payload.sid,
			};

			const ipAddress = deps.getClientIp?.(ctx) ?? "unknown";
			const ua = ctx.req.header("user-agent") ?? "";

			return createBridgeHandler(principal, {
				env,
				ipAddress,
				ua,
				obsEmitEvent: deps.obsEmitEvent as Parameters<
					typeof createBridgeHandler
				>[1]["obsEmitEvent"],
			});
		}),
	);
}
