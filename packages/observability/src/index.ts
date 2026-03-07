/**
 * @file index.ts
 * Public API for the observability plugin (ADR-008).
 * Plugin-only – removable by deleting packages/observability and commenting mount line in app.ts.
 *
 * @license Apache-2.0
 */

import type { Env, GetClientIpFn, Variables } from "@private-landing/types";
import type { Hono } from "hono";
import {
	type AdaptiveChallengeOpts,
	createAdaptiveChallenge,
	createObsEmit,
} from "./middleware";
import {
	APP_ACTOR_ID,
	EventTypes,
	processEvent,
	type SecurityEvent,
} from "./process-event";
import { createOpsRouter, type OpsRouterDeps } from "./router";

export type { ResolvedAdaptiveConfig } from "./config";
export { computeChallenge } from "./process-event";
export type { AdaptiveChallengeOpts };
export type { AgentPrincipal, TrustLevel } from "./types";
export { APP_ACTOR_ID, EventTypes };
export type { SecurityEvent };
export { getAgentPrincipal, requireAgentKey } from "./require-agent-key";
export { upgradeWebSocket, type WSEvents } from "./ws/upgrade";

/**
 * Dependencies for the observability plugin.
 * @property getClientIp - IP extraction function for rate limiting and audit trail
 * @property actorId - Override for the actor identity on emitted events
 */
export interface ObservabilityPluginDeps extends OpsRouterDeps {
	getClientIp?: GetClientIpFn;
	actorId?: string;
}

/**
 * Mount the observability sub-router at /ops and return bound helpers.
 * Call once in app.ts: `const { obsEmit, obsEmitEvent, adaptiveChallenge, opsRouter, mountAgentWs } = observabilityPlugin(app, deps)`
 *
 * The agent-key WebSocket handler is NOT mounted by default — call `mountAgentWs(opsRouter)`
 * in app.ts to enable it, or use the control plugin which provides its own /ops/ws handler (ADR-010).
 */
export function observabilityPlugin(
	app: Hono<{
		Bindings: Env & { AGENT_PROVISIONING_SECRET?: string };
		Variables: Variables;
	}>,
	deps: ObservabilityPluginDeps = {},
) {
	const { router: opsRouter, mountAgentWs } = createOpsRouter(deps);

	/** Mount /ops routes. Call after all plugins have registered on opsRouter. */
	const mountOps = () => app.route("/ops", opsRouter);

	const obsEmit = createObsEmit({
		getClientIp: deps.getClientIp,
		actorId: deps.actorId,
	});
	const obsEmitEvent = createObsEmitEvent({
		getClientIp: deps.getClientIp,
		actorId: deps.actorId,
	});
	const adaptiveChallenge = createAdaptiveChallenge(deps.getClientIp);
	const adaptiveChallengeFor = (opts: AdaptiveChallengeOpts) =>
		createAdaptiveChallenge(deps.getClientIp, opts);

	return {
		obsEmit,
		obsEmitEvent,
		adaptiveChallenge,
		adaptiveChallengeFor,
		opsRouter,
		mountOps,
		mountAgentWs,
		getClientIp: deps.getClientIp,
	};
}

/** Structural subset of ExecutionContext — avoids leaking @cloudflare/workers-types. */
interface WaitUntilCtx {
	waitUntil(promise: Promise<unknown>): void;
}

/** Minimal context shape accepted by obsEmitEvent. */
type EmitCtx = {
	req: { url: string; header: (name: string) => string | undefined };
	env: Env;
	executionCtx?: WaitUntilCtx;
};

/**
 * Dependencies for the fire-and-forget event emitter.
 * @property getClientIp - IP extraction function (defaults to "unknown")
 * @property actorId - Override for the actor identity on emitted events
 */
interface ObsEmitEventDeps {
	getClientIp?: GetClientIpFn;
	actorId?: string;
}

/**
 * Create a fire-and-forget emitter bound to the configured deps.
 * Use for cases where obsEmit middleware is insufficient (e.g., session.revoke_all).
 * Calls processEvent directly instead of HTTP self-fetch.
 */
function createObsEmitEvent(deps: ObsEmitEventDeps) {
	return function obsEmitEvent(
		ctx: EmitCtx,
		event: Pick<SecurityEvent, "type" | "userId" | "detail">,
	): void {
		const full: SecurityEvent = {
			...event,
			created_at: new Date().toISOString(),
			ipAddress: deps.getClientIp
				? deps.getClientIp(ctx as Parameters<GetClientIpFn>[0])
				: "unknown",
			ua: ctx.req.header("user-agent") ?? "",
			status: 200,
			actorId: deps.actorId ?? APP_ACTOR_ID,
		};
		const promise = processEvent(full, {
			env: ctx.env,
		}).catch((err) => console.error("[obs] emit failed:", err));

		if (ctx.executionCtx?.waitUntil) {
			ctx.executionCtx.waitUntil(promise);
		}
	};
}
