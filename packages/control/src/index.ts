/**
 * @file index.ts
 * Public API for the control plugin (ADR-010).
 * Layers on top of packages/observability — requires opsRouter from observabilityPlugin().
 * Plugin-only – removable by deleting packages/control and commenting mount line in app.ts.
 *
 * @license Apache-2.0
 */

import { upgradeWebSocket } from "@private-landing/observability";
import type { Env, GetClientIpFn } from "@private-landing/types";
import type { Hono } from "hono";
import type { MiddlewareHandler } from "hono/types";
import { createProxyHandler } from "./bridge/handler";
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
 * Mount control routes on the ops router.
 * Call after observabilityPlugin() in app.ts:
 * `controlPlugin(opsRouter, { requireAuth, obsEmitEvent })`
 */
export function controlPlugin(
	// biome-ignore lint/suspicious/noExplicitAny: accepts any ops router shape
	opsRouter: Hono<any>,
	deps: ControlPluginDeps,
): void {
	const ipAllowlist = createIpAllowlist(deps.getClientIp);

	// Cloaked auth — convert auth failures to 404 so unauthenticated
	// requests are indistinguishable from non-existent routes (ADR-010).
	// Browser navigations to /control* redirect to login instead of 404;
	// non-browser clients (scanners, curl) still see 404 (cloaked).
	const cloakedAuth: MiddlewareHandler = async (ctx, next) => {
		let authed = false;
		await deps.requireAuth(ctx, async () => {
			authed = true;
		});
		if (!authed) {
			const isNav =
				ctx.req.header("sec-fetch-dest") === "document" ||
				ctx.req.header("sec-fetch-mode") === "navigate";
			if (isNav) {
				const returnPath = new URL(ctx.req.url).pathname;
				return ctx.redirect(`/?return=${encodeURIComponent(returnPath)}`, 302);
			}
			return ctx.notFound();
		}
		return next();
	};

	// WebSocket upgrade handler shared by /control/* and /ws routes.
	const proxyUpgrade = upgradeWebSocket((ctx) => {
		const env = ctx.env as ControlBindings;
		const payload = ctx.get("jwtPayload") as { uid: number; sid: string };
		const principal: BridgePrincipal = {
			id: `user:${payload.uid}`,
			name: `user-${payload.uid}`,
			uid: payload.uid,
			sid: payload.sid,
		};

		return createProxyHandler(principal, {
			env,
			ipAddress: deps.getClientIp?.(ctx) ?? "unknown",
			ua: ctx.req.header("user-agent") ?? "",
			origin: ctx.req.header("origin"),
			obsEmitEvent: deps.obsEmitEvent as Parameters<
				typeof createProxyHandler
			>[1]["obsEmitEvent"],
		});
	});

	// Redirect /control → /control/ for non-WebSocket requests so the
	// browser resolves relative asset URLs correctly (trailing slash base).
	const controlHandler: MiddlewareHandler = async (ctx, next) => {
		const env = ctx.env as ControlBindings;
		if (!env.GATEWAY_URL) {
			return ctx.notFound();
		}

		// WebSocket upgrade → transparent proxy (same handler as /ws cookie path)
		if (ctx.req.header("upgrade")?.toLowerCase() === "websocket") {
			if (!env.GATEWAY_TOKEN) return ctx.notFound();
			return proxyUpgrade(ctx, next);
		}

		deps.obsEmitEvent?.(ctx, {
			type: "control.proxy",
			detail: { path: ctx.req.path, method: ctx.req.method },
		});

		return proxyToGateway(ctx, env.GATEWAY_URL);
	};

	// /control (no trailing slash, no wildcard) — redirect HTTP, allow WS
	opsRouter.all(
		"/control",
		cloakedAuth,
		userOneGuard,
		ipAllowlist,
		async (ctx, next) => {
			// Allow WebSocket upgrades at /ops/control (no redirect)
			if (ctx.req.header("upgrade")?.toLowerCase() === "websocket") {
				return controlHandler(ctx, next);
			}
			// HTTP requests: 308 → /ops/control/ so relative assets resolve correctly
			const url = new URL(ctx.req.url);
			url.pathname += "/";
			return ctx.redirect(url.pathname + url.search, 308);
		},
	);

	// /control/* — static assets + WS upgrade
	opsRouter.all(
		"/control/*",
		cloakedAuth,
		userOneGuard,
		ipAllowlist,
		controlHandler,
	);

	// Defensive: proxy /assets/* for cases where the browser loads /ops/control
	// without trailing slash before the redirect (cached HTML, preloaded links).
	opsRouter.all(
		"/assets/*",
		cloakedAuth,
		userOneGuard,
		ipAllowlist,
		async (ctx) => {
			const env = ctx.env as ControlBindings;
			if (!env.GATEWAY_URL) return ctx.notFound();
			return proxyToGateway(ctx, env.GATEWAY_URL);
		},
	);

	// WebSocket proxy multiplexer (ADR-010 §WebSocket Multiplexing)
	// Intercepts cookie-based connections on /ws for the proxy handler.
	// Bearer-based connections fall through to the agent handler (mountAgentWs).
	opsRouter.get("/ws", async (ctx, next) => {
		// Bearer header → agent path (fall through to mountAgentWs handler)
		if (ctx.req.header("authorization")?.startsWith("Bearer ")) {
			return next();
		}

		const env = ctx.env as ControlBindings;

		// No gateway configured → cloak (non-Bearer requests must not
		// fall through to the agent handler, which would return 401
		// and reveal the endpoint exists)
		if (!env.GATEWAY_URL || !env.GATEWAY_TOKEN) {
			return ctx.notFound();
		}

		// Cookie-based auth → proxy path (cloakedAuth → userOneGuard → ipAllowlist → upgrade)
		let authed = false;
		await deps.requireAuth(ctx, async () => {
			authed = true;
		});
		if (!authed) return ctx.notFound();

		// userOneGuard inline — must be uid=1
		const payload = ctx.get("jwtPayload") as { uid: number };
		if (payload?.uid !== 1) return ctx.notFound();

		// IP allowlist — delegate to middleware, short-circuit on rejection
		let ipPassed = false;
		await ipAllowlist(ctx, async () => {
			ipPassed = true;
		});
		if (!ipPassed) return ctx.notFound();

		return proxyUpgrade(ctx, next);
	});
}
