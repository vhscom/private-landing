/**
 * @file require-agent-key.ts
 * Agent authentication middleware. Extracts Bearer token, hashes with SHA-256,
 * and looks up the agent credential. Sets agentPrincipal on context or returns 401.
 * Plugin-only – removable by deleting packages/observability.
 *
 * @license Apache-2.0
 */

import { createDbClient } from "@private-landing/infrastructure";
import type { Env, Variables } from "@private-landing/types";
import type { Context } from "hono";
import { APP_ACTOR_ID, EventTypes, processEvent } from "./process-event";
import type { AgentPrincipal, TrustLevel } from "./types";

/** Plugin-specific Variables extension including the agent principal. */
export type OpsVariables = Variables & { agentPrincipal: AgentPrincipal };

/** Typed context for the /ops sub-router. */
type OpsContext = Context<{
	Bindings: Env & { AGENT_PROVISIONING_SECRET?: string };
	Variables: OpsVariables;
}>;

/**
 * Hashes a raw API key with SHA-256 and returns the hex digest.
 * Agent keys are high-entropy (256 bits), so SHA-256 is appropriate
 * without key-stretching (see ADR-008).
 */
export async function hashApiKey(rawKey: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(rawKey),
	);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** Type-safe accessor for the agent principal set by requireAgentKey. */
export function getAgentPrincipal(ctx: OpsContext): AgentPrincipal {
	return ctx.get("agentPrincipal");
}

/** Fire-and-forget agent auth failure event. */
function emitAgentAuthFailure(ctx: OpsContext, code: string): void {
	const promise = processEvent(
		{
			type: EventTypes.AGENT_AUTH_FAILURE,
			created_at: new Date().toISOString(),
			ipAddress: ctx.req.header("cf-connecting-ip") ?? "unknown",
			ua: ctx.req.header("user-agent") ?? "",
			status: 401,
			actorId: APP_ACTOR_ID,
			detail: { code, path: ctx.req.path },
		},
		{ env: ctx.env },
	).catch((err) => console.error("[obs] agent auth event failed:", err));

	try {
		ctx.executionCtx?.waitUntil(promise);
	} catch {
		// No ExecutionContext in test environments — fire-and-forget only
	}
}

/**
 * Agent authentication middleware.
 * Extracts Bearer token, hashes with SHA-256, looks up agent_credential.
 * On match: sets agentPrincipal on context. On miss: returns 401.
 */
export async function requireAgentKey(
	ctx: OpsContext,
	next: () => Promise<void>,
): Promise<Response | undefined> {
	const authHeader = ctx.req.header("authorization");
	if (!authHeader?.startsWith("Bearer ")) {
		emitAgentAuthFailure(ctx, "MISSING_API_KEY");
		return ctx.json({ error: "Unauthorized", code: "MISSING_API_KEY" }, 401);
	}

	const rawKey = authHeader.slice(7);
	const keyHash = await hashApiKey(rawKey);

	try {
		const db = createDbClient(ctx.env);
		const result = await db.execute({
			sql: "SELECT id, name, trust_level FROM agent_credential WHERE key_hash = ? AND revoked_at IS NULL",
			args: [keyHash],
		});

		if (result.rows.length === 0) {
			emitAgentAuthFailure(ctx, "INVALID_API_KEY");
			return ctx.json({ error: "Unauthorized", code: "INVALID_API_KEY" }, 401);
		}

		const row = result.rows[0] as unknown as {
			id: number;
			name: string;
			trust_level: string;
		};
		const principal: AgentPrincipal = {
			id: row.id,
			name: row.name,
			trustLevel: row.trust_level as TrustLevel,
		};
		ctx.set("agentPrincipal", principal);
	} catch (err) {
		console.error("[obs] agent key lookup failed:", err);
		emitAgentAuthFailure(ctx, "INVALID_API_KEY");
		return ctx.json({ error: "Unauthorized", code: "INVALID_API_KEY" }, 401);
	}

	await next();
}
