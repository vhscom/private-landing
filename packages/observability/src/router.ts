/**
 * @file router.ts
 * Hono sub-router for /ops endpoints. Plugin-only – removable by deleting packages/observability.
 *
 * @license Apache-2.0
 */

import { defaultGetClientIp, timingSafeEqual } from "@private-landing/core";
import {
	type CacheClientFactory,
	createDbClient,
} from "@private-landing/infrastructure";
import type { Env, GetClientIpFn } from "@private-landing/types";
import { Hono } from "hono";
import { z } from "zod";
import { APP_ACTOR_ID, processEvent } from "./process-event";
import {
	getAgentPrincipal,
	hashApiKey,
	type OpsVariables,
	requireAgentKey,
} from "./require-agent-key";
import { ensureSchema } from "./schema";

export interface OpsRouterDeps {
	createCacheClient?: CacheClientFactory;
	getClientIp?: GetClientIpFn;
}

/** Create the /ops sub-router. Mounted by observabilityPlugin(). */
export function createOpsRouter(deps: OpsRouterDeps) {
	const router = new Hono<{
		Bindings: Env & { AGENT_PROVISIONING_SECRET?: string };
		Variables: OpsVariables;
	}>();

	const getClientIp = deps.getClientIp ?? defaultGetClientIp;

	/** Awaited event emission for mutating ops routes. */
	async function emitOpsEvent(
		ctx: { env: Env; req: { header(name: string): string | undefined } },
		type: string,
		actorId: string,
		detail?: Record<string, unknown>,
	): Promise<void> {
		let ip = "unknown";
		try {
			ip = getClientIp(ctx as Parameters<GetClientIpFn>[0]);
		} catch {
			// getConnInfo may not be available in all contexts
		}
		await processEvent(
			{
				type,
				created_at: new Date().toISOString(),
				ipAddress: ip,
				ua: ctx.req.header("user-agent") ?? "",
				status: 200,
				actorId,
				detail,
			},
			{ env: ctx.env },
		).catch((err) => console.error("[obs] ops event emit failed:", err));
	}

	// ADR-008: Cloak entire /ops surface when provisioning secret is absent
	router.use("*", async (ctx, next) => {
		if (!ctx.env.AGENT_PROVISIONING_SECRET) {
			return ctx.notFound();
		}
		return next();
	});

	router.get("/sessions", requireAgentKey, async (ctx) => {
		const userId = ctx.req.query("user_id");
		const activeOnly = ctx.req.query("active") !== "false";
		const limit = Math.min(Number(ctx.req.query("limit") ?? 50), 200);
		const offset = Number(ctx.req.query("offset") ?? 0);

		const clauses: string[] = [];
		const args: (string | number)[] = [];

		if (activeOnly) {
			clauses.push("expires_at > datetime('now')");
		}
		if (userId) {
			clauses.push("user_id = ?");
			args.push(Number(userId));
		}

		try {
			const db = createDbClient(ctx.env);
			const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
			const result = await db.execute({
				sql: `SELECT id, user_id, ip_address, user_agent, created_at, expires_at FROM session ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
				args: [...args, limit, offset],
			});
			return ctx.json({ sessions: result.rows, count: result.rows.length });
		} catch (err) {
			console.error("[obs] sessions query failed:", err);
			return ctx.json({ error: "Internal error", code: "INTERNAL_ERROR" }, 500);
		}
	});

	router.post("/sessions/revoke", requireAgentKey, async (ctx) => {
		const principal = getAgentPrincipal(ctx);
		if (principal.trustLevel !== "write") {
			return ctx.json(
				{ error: "Forbidden", code: "INSUFFICIENT_TRUST_LEVEL" },
				403,
			);
		}

		const body = await ctx.req.json();
		const parsed = z.safeParse(
			z.object({
				scope: z.enum(["all", "user", "session"]),
				id: z.union([z.number(), z.string()]).optional(),
			}),
			body,
		);
		if (!parsed.success) {
			return ctx.json(
				{ error: "Invalid body", issues: parsed.error.issues },
				400,
			);
		}

		const { scope, id } = parsed.data;
		if ((scope === "user" || scope === "session") && id == null) {
			return ctx.json(
				{ error: `id required for ${scope} scope`, code: "VALIDATION_ERROR" },
				400,
			);
		}

		const db = createDbClient(ctx.env);
		let revoked = 0;

		// Collect affected user IDs before the UPDATE so we can invalidate cache
		let affectedUserIds: string[] = [];
		if (deps.createCacheClient && scope === "all") {
			try {
				const rows = await db.execute(
					"SELECT DISTINCT user_id FROM session WHERE expires_at > datetime('now')",
				);
				affectedUserIds = rows.rows.map((r) => String(r.user_id));
			} catch {
				// Best-effort — proceed with SQL revocation regardless
			}
		}

		try {
			switch (scope) {
				case "all": {
					const result = await db.execute(
						"UPDATE session SET expires_at = datetime('now') WHERE expires_at > datetime('now')",
					);
					revoked = result.rowsAffected;
					break;
				}
				case "user": {
					const result = await db.execute({
						sql: "UPDATE session SET expires_at = datetime('now') WHERE user_id = ? AND expires_at > datetime('now')",
						args: [Number(id)],
					});
					revoked = result.rowsAffected;
					break;
				}
				case "session": {
					const result = await db.execute({
						sql: "UPDATE session SET expires_at = datetime('now') WHERE id = ? AND expires_at > datetime('now')",
						args: [String(id)],
					});
					revoked = result.rowsAffected;
					break;
				}
			}
		} catch (err) {
			console.error("[obs] revocation error:", err);
			return ctx.json(
				{ error: "Revocation failed", code: "REVOCATION_ERROR" },
				500,
			);
		}

		// Best-effort cache invalidation using user_sessions:{uid} sets
		// populated by cached-session-service (no active_users set needed)
		if (deps.createCacheClient) {
			try {
				const cache = deps.createCacheClient(ctx.env);
				switch (scope) {
					case "all": {
						for (const uid of affectedUserIds) {
							const sids = await cache.smembers(`user_sessions:${uid}`);
							for (const sid of sids) {
								await cache.del(`session:${sid}`);
							}
							await cache.del(`user_sessions:${uid}`);
						}
						break;
					}
					case "user": {
						const uid = String(id);
						const sids = await cache.smembers(`user_sessions:${uid}`);
						for (const sid of sids) {
							await cache.del(`session:${sid}`);
						}
						await cache.del(`user_sessions:${uid}`);
						break;
					}
					case "session": {
						const sid = String(id);
						const raw = await cache.get(`session:${sid}`);
						if (raw) {
							const session = JSON.parse(raw) as { userId: number };
							const uid = String(session.userId);
							await cache.srem(`user_sessions:${uid}`, sid);
						}
						await cache.del(`session:${sid}`);
						break;
					}
				}
			} catch (err) {
				console.error("[obs] cache cleanup error:", err);
			}
		}

		await emitOpsEvent(ctx, "session.ops_revoke", `agent:${principal.name}`, {
			scope,
			id: id ?? undefined,
			revoked,
		});
		return ctx.json({ success: true, revoked });
	});

	// Agent provisioning (ADR-008)
	router.post("/agents", async (ctx) => {
		const secret = ctx.req.header("x-provisioning-secret") ?? "";
		const encoder = new TextEncoder();
		const match = await timingSafeEqual(
			encoder.encode(secret),
			encoder.encode(ctx.env.AGENT_PROVISIONING_SECRET ?? ""),
		);
		if (!match) {
			return ctx.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401);
		}

		const body = await ctx.req.json();
		const parsed = z.safeParse(
			z.object({
				name: z.string().min(1),
				trustLevel: z.enum(["read", "write"]).optional(),
				description: z.string().max(200).optional(),
			}),
			body,
		);
		if (!parsed.success) {
			return ctx.json(
				{ error: "Invalid body", issues: parsed.error.issues },
				400,
			);
		}

		const trustLevel = parsed.data.trustLevel ?? "read";

		await ensureSchema(ctx.env);
		const db = createDbClient(ctx.env);

		const rawKeyBytes = new Uint8Array(32);
		crypto.getRandomValues(rawKeyBytes);
		const rawKey = Array.from(rawKeyBytes)
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		const keyHash = await hashApiKey(rawKey);

		try {
			await db.execute({
				sql: "INSERT INTO agent_credential (name, key_hash, trust_level, description) VALUES (?, ?, ?, ?)",
				args: [
					parsed.data.name,
					keyHash,
					trustLevel,
					parsed.data.description ?? null,
				],
			});
		} catch (err) {
			console.error("[obs] agent provision failed:", err);
			return ctx.json(
				{ error: "Agent name already exists", code: "AGENT_EXISTS" },
				409,
			);
		}

		await emitOpsEvent(ctx, "agent.provisioned", APP_ACTOR_ID, {
			name: parsed.data.name,
			trustLevel,
		});
		return ctx.json({
			name: parsed.data.name,
			apiKey: rawKey,
			createdAt: new Date().toISOString(),
		});
	});

	router.delete("/agents/:name", async (ctx) => {
		const secret = ctx.req.header("x-provisioning-secret") ?? "";
		const encoder = new TextEncoder();
		const match = await timingSafeEqual(
			encoder.encode(secret),
			encoder.encode(ctx.env.AGENT_PROVISIONING_SECRET ?? ""),
		);
		if (!match) {
			return ctx.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401);
		}

		const name = ctx.req.param("name");
		const db = createDbClient(ctx.env);

		const result = await db.execute({
			sql: "UPDATE agent_credential SET revoked_at = datetime('now') WHERE name = ? AND revoked_at IS NULL",
			args: [name],
		});

		if (result.rowsAffected === 0) {
			return ctx.json({ error: "Not found", code: "NOT_FOUND" }, 404);
		}

		await emitOpsEvent(ctx, "agent.revoked", APP_ACTOR_ID, { name });
		return ctx.json({ success: true });
	});

	router.get("/agents", requireAgentKey, async (ctx) => {
		try {
			const db = createDbClient(ctx.env);
			const result = await db.execute({
				sql: "SELECT id, name, trust_level, description, created_at, revoked_at FROM agent_credential WHERE revoked_at IS NULL ORDER BY created_at DESC",
				args: [],
			});
			return ctx.json({ agents: result.rows });
		} catch (err) {
			console.error("[obs] agents list failed:", err);
			return ctx.json({ error: "Internal error", code: "INTERNAL_ERROR" }, 500);
		}
	});

	// Event query (ADR-008)
	router.get("/events", requireAgentKey, async (ctx) => {
		const since =
			ctx.req.query("since") ??
			new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
		const limit = Math.min(Number(ctx.req.query("limit") ?? 50), 200);
		const offset = Number(ctx.req.query("offset") ?? 0);

		const clauses: string[] = ["created_at >= ?"];
		const args: (string | number)[] = [since];

		const type = ctx.req.query("type");
		if (type) {
			clauses.push("type = ?");
			args.push(type);
		}
		const userId = ctx.req.query("user_id");
		if (userId) {
			clauses.push("user_id = ?");
			args.push(Number(userId));
		}
		const ip = ctx.req.query("ip");
		if (ip) {
			clauses.push("ip_address = ?");
			args.push(ip);
		}
		const actorId = ctx.req.query("actor_id");
		if (actorId) {
			clauses.push("actor_id = ?");
			args.push(actorId);
		}

		try {
			const db = createDbClient(ctx.env);
			const where = clauses.join(" AND ");
			const result = await db.execute({
				sql: `SELECT id, type, ip_address, user_id, detail, created_at, actor_id FROM security_event WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
				args: [...args, limit, offset],
			});
			return ctx.json({ events: result.rows, count: result.rows.length });
		} catch (err) {
			console.error("[obs] events query failed:", err);
			return ctx.json({ error: "Internal error", code: "INTERNAL_ERROR" }, 500);
		}
	});

	router.get("/events/stats", requireAgentKey, async (ctx) => {
		const since =
			ctx.req.query("since") ??
			new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

		try {
			const db = createDbClient(ctx.env);
			const result = await db.execute({
				sql: "SELECT type, COUNT(*) as count FROM security_event WHERE created_at >= ? GROUP BY type",
				args: [since],
			});
			const stats: Record<string, number> = {};
			for (const row of result.rows) {
				const r = row as unknown as { type: string; count: number };
				stats[r.type] = r.count;
			}
			return ctx.json({ since, stats });
		} catch (err) {
			console.error("[obs] events stats failed:", err);
			return ctx.json({ error: "Internal error", code: "INTERNAL_ERROR" }, 500);
		}
	});

	return router;
}
