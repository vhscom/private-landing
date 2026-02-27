/**
 * @file index.ts
 * Public API for the observability plugin (ADR-008).
 * Plugin-only – removable by deleting packages/observability and commenting mount line in app.ts.
 *
 * @license Apache-2.0
 */

import type { Env, GetClientIpFn, Variables } from "@private-landing/types";
import type { Hono } from "hono";
import { createAdaptiveChallenge, createObsEmit } from "./middleware";
import {
	APP_ACTOR_ID,
	EventTypes,
	processEvent,
	type SecurityEvent,
} from "./process-event";
import { createOpsRouter, type OpsRouterDeps } from "./router";

export type { ResolvedAdaptiveConfig } from "./config";
export { computeChallenge } from "./process-event";
export type { AgentPrincipal, TrustLevel } from "./types";
export { APP_ACTOR_ID, EventTypes };
export type { SecurityEvent };
export { getAgentPrincipal, requireAgentKey } from "./require-agent-key";

export interface ObservabilityPluginDeps extends OpsRouterDeps {
	getClientIp?: GetClientIpFn;
	actorId?: string;
}

/**
 * Mount the observability sub-router at /ops and return bound helpers.
 * Call once in app.ts: `const { obsEmit, obsEmitEvent, adaptiveChallenge } = observabilityPlugin(app, deps)`
 */
export function observabilityPlugin(
	app: Hono<{
		Bindings: Env & { AGENT_PROVISIONING_SECRET?: string };
		Variables: Variables;
	}>,
	deps: ObservabilityPluginDeps = {},
) {
	app.route("/ops", createOpsRouter(deps));

	const obsEmit = createObsEmit({
		getClientIp: deps.getClientIp,
		actorId: deps.actorId,
	});
	const obsEmitEvent = createObsEmitEvent({
		getClientIp: deps.getClientIp,
		actorId: deps.actorId,
	});
	const adaptiveChallenge = createAdaptiveChallenge(deps.getClientIp);

	return { obsEmit, obsEmitEvent, adaptiveChallenge };
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
