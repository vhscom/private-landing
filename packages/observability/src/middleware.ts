/**
 * @file middleware.ts
 * Observability middleware: event emission (ADR-008) and adaptive challenges.
 * Plugin-only – removable by deleting packages/observability.
 *
 * @license Apache-2.0
 */

import type { Env, GetClientIpFn, Variables } from "@private-landing/types";
import { createMiddleware } from "hono/factory";
import { adaptiveDefaults } from "./config";
import {
	APP_ACTOR_ID,
	computeChallenge,
	processEvent,
	type SecurityEvent,
} from "./process-event";

export interface ObsEmitDeps {
	getClientIp?: GetClientIpFn;
	actorId?: string;
}

/**
 * Returns an obsEmit factory bound to the configured deps.
 * obsEmit(eventType) returns after-handler middleware that processes a structured
 * event directly via processEvent. Always emits — no toggle.
 */
export function createObsEmit(deps: ObsEmitDeps = {}) {
	return function obsEmit(eventType: string) {
		return createMiddleware<{
			Bindings: Env;
			Variables: Variables;
		}>(async (ctx, next) => {
			await next();

			const payload = ctx.get("jwtPayload") as
				| { uid: number; sid: string }
				| undefined;

			const resolvedType =
				ctx.res.status >= 400 && eventType.endsWith(".success")
					? eventType.replace(/\.success$/, ".failure")
					: eventType;

			const event: SecurityEvent = {
				type: resolvedType,
				created_at: new Date().toISOString(),
				userId: payload?.uid,
				ipAddress: deps.getClientIp ? deps.getClientIp(ctx) : "unknown",
				ua: ctx.req.header("user-agent") ?? "",
				status: ctx.res.status,
				actorId: deps.actorId ?? APP_ACTOR_ID,
			};

			const promise = processEvent(event, {
				env: ctx.env,
			}).catch((err) => console.error("[obs] emit failed:", err));

			if (ctx.executionCtx?.waitUntil) {
				ctx.executionCtx.waitUntil(promise);
			}
		});
	};
}

export interface AdaptiveChallengeOpts {
	/** Event type to query for failure count. Default: "login.failure" */
	eventType?: string;
}

/**
 * Returns before-handler middleware that enforces PoW challenges on high-risk requests.
 * Calls computeChallenge directly. Fails open on error.
 */
export function createAdaptiveChallenge(
	getClientIp?: GetClientIpFn,
	opts: AdaptiveChallengeOpts = {},
) {
	return createMiddleware<{
		Bindings: Env;
		Variables: Variables;
	}>(async (ctx, next) => {
		const ip = getClientIp ? getClientIp(ctx) : "unknown";
		const ua = ctx.req.header("user-agent") ?? "";

		const emit = async (type: string, status: number, difficulty: number) => {
			const event: SecurityEvent = {
				type,
				created_at: new Date().toISOString(),
				ipAddress: ip,
				ua,
				status,
				detail: { difficulty },
				actorId: APP_ACTOR_ID,
			};
			const promise = processEvent(event, { env: ctx.env }).catch((err) =>
				console.error("[obs] challenge event failed:", err),
			);
			if (ctx.executionCtx?.waitUntil) {
				ctx.executionCtx.waitUntil(promise);
			} else {
				await promise;
			}
		};

		try {
			const challenge = await computeChallenge(
				ip,
				ctx.env,
				adaptiveDefaults,
				opts.eventType,
			);

			if (!challenge) return next();

			const contentType = ctx.req.header("content-type") ?? "";
			if (!contentType.includes("application/json")) {
				await emit("challenge.issued", 403, challenge.difficulty);
				return ctx.json({ error: "Challenge required", challenge }, 403);
			}

			const body = await ctx.req.raw.clone().json();
			const { challengeNonce, challengeSolution } = body as {
				challengeNonce?: string;
				challengeSolution?: string;
			};

			if (!challengeNonce || !challengeSolution) {
				await emit("challenge.issued", 403, challenge.difficulty);
				return ctx.json({ error: "Challenge required", challenge }, 403);
			}

			const hash = Array.from(
				new Uint8Array(
					await crypto.subtle.digest(
						"SHA-256",
						new TextEncoder().encode(challengeNonce + challengeSolution),
					),
				),
			)
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");

			const prefix = "0".repeat(challenge.difficulty);
			if (!hash.startsWith(prefix)) {
				await emit("challenge.failed", 403, challenge.difficulty);
				return ctx.json({ error: "Invalid solution", challenge }, 403);
			}
		} catch (err) {
			console.error("[obs] adaptive challenge error:", err);
		}

		return next();
	});
}
