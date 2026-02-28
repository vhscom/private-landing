/**
 * @file router.test.ts
 * Unit tests for /ops sub-router endpoints.
 *
 * @license Apache-2.0
 */

import type { Env } from "@private-landing/types";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpsVariables } from "../src/require-agent-key";

const mockExecute = vi.fn();
const mockEnsureSchema = vi.fn();

vi.mock("@private-landing/infrastructure", () => ({
	createDbClient: vi.fn(() => ({ execute: mockExecute })),
}));

vi.mock("@private-landing/core", () => ({
	timingSafeEqual: vi.fn(),
	defaultGetClientIp: vi.fn(() => "192.0.2.1"),
}));

const mockProcessEvent = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/schema", () => ({
	ensureSchema: (...args: unknown[]) => mockEnsureSchema(...args),
}));

vi.mock("../src/process-event", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../src/process-event")>();
	return {
		...original,
		processEvent: (...args: unknown[]) => mockProcessEvent(...args),
	};
});

import { timingSafeEqual } from "@private-landing/core";
import { createOpsRouter } from "../src/router";

type AppEnv = {
	Bindings: Env & { AGENT_PROVISIONING_SECRET?: string };
	Variables: OpsVariables;
};

const baseEnv: AppEnv["Bindings"] = {
	AUTH_DB_URL: "libsql://test.turso.io",
	AUTH_DB_TOKEN: "test-token",
	JWT_ACCESS_SECRET: "test",
	JWT_REFRESH_SECRET: "test",
	AGENT_PROVISIONING_SECRET: "test-secret",
} as AppEnv["Bindings"];

/** Agent credential row returned by requireAgentKey's DB lookup. */
const AGENT_ROW = { id: 1, name: "test-agent", trust_level: "write" };

function buildApp() {
	const router = createOpsRouter({});
	const app = new Hono<AppEnv>();
	app.route("/ops", router);
	return app;
}

/**
 * Helper: configure mockExecute to first return an agent credential row
 * (for requireAgentKey middleware), then chain additional responses.
 */
function withAgentAuth(...subsequentResults: unknown[]) {
	let chain = mockExecute.mockResolvedValueOnce({ rows: [AGENT_ROW] });
	for (const result of subsequentResults) {
		chain = chain.mockResolvedValueOnce(result);
	}
}

describe("ops surface cloaking (ADR-008)", () => {
	it("returns 404 for all /ops routes when provisioning secret is absent", async () => {
		const app = buildApp();
		const envNoSecret = { ...baseEnv, AGENT_PROVISIONING_SECRET: undefined };

		const endpoints = [
			["/ops/agents", "GET"],
			["/ops/agents", "POST"],
			["/ops/events", "GET"],
			["/ops/sessions", "GET"],
		] as const;

		for (const [path, method] of endpoints) {
			const res = await app.request(
				path,
				{ method, headers: { Authorization: "Bearer valid-key" } },
				envNoSecret,
			);
			expect(res.status, `${method} ${path}`).toBe(404);
		}
	});
});

describe("POST /ops/agents", () => {
	beforeEach(() => {
		mockExecute.mockReset();
		mockEnsureSchema.mockReset();
		(timingSafeEqual as ReturnType<typeof vi.fn>).mockReset();
	});

	it("returns 401 when x-provisioning-secret is missing", async () => {
		(timingSafeEqual as ReturnType<typeof vi.fn>).mockResolvedValue(false);
		const app = buildApp();
		const res = await app.request(
			"/ops/agents",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "agent" }),
			},
			baseEnv,
		);
		expect(res.status).toBe(401);
	});

	it("returns 400 for invalid body", async () => {
		(timingSafeEqual as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		const app = buildApp();
		const res = await app.request(
			"/ops/agents",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-provisioning-secret": "test-secret",
				},
				body: JSON.stringify({}),
			},
			baseEnv,
		);
		expect(res.status).toBe(400);
	});

	it("returns apiKey for valid provisioning request", async () => {
		(timingSafeEqual as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		mockExecute.mockResolvedValue({ rows: [], rowsAffected: 1 });
		const app = buildApp();
		const res = await app.request(
			"/ops/agents",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-provisioning-secret": "test-secret",
				},
				body: JSON.stringify({ name: "new-agent", trustLevel: "read" }),
			},
			baseEnv,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.name).toBe("new-agent");
		expect(body.apiKey).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("GET /ops/agents", () => {
	beforeEach(() => {
		mockExecute.mockReset();
	});

	it("returns agent list for authenticated agent", async () => {
		withAgentAuth({
			rows: [
				{
					id: 1,
					name: "agent-a",
					trust_level: "read",
					created_at: "2026-01-01",
					revoked_at: null,
				},
			],
		});
		const app = buildApp();
		const res = await app.request(
			"/ops/agents",
			{ headers: { Authorization: "Bearer valid-key" } },
			baseEnv,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.agents).toHaveLength(1);
		expect(body.agents[0].name).toBe("agent-a");
	});

	it("returns 401 without auth", async () => {
		const app = buildApp();
		const res = await app.request("/ops/agents", {}, baseEnv);
		expect(res.status).toBe(401);
	});
});

describe("GET /ops/events", () => {
	beforeEach(() => {
		mockExecute.mockReset();
	});

	it("returns events for authenticated agent", async () => {
		withAgentAuth({
			rows: [
				{
					id: 1,
					type: "login.success",
					ip_address: "1.2.3.4",
					created_at: "2026-01-01",
				},
			],
		});
		const app = buildApp();
		const res = await app.request(
			"/ops/events",
			{ headers: { Authorization: "Bearer valid-key" } },
			baseEnv,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.events).toHaveLength(1);
	});

	it("returns 401 without auth", async () => {
		const app = buildApp();
		const res = await app.request("/ops/events", {}, baseEnv);
		expect(res.status).toBe(401);
	});
});

describe("POST /ops/sessions/revoke", () => {
	beforeEach(() => {
		mockExecute.mockReset();
	});

	it("returns 403 for read-only agent", async () => {
		mockExecute.mockResolvedValueOnce({
			rows: [{ id: 1, name: "reader", trust_level: "read" }],
		});
		const app = buildApp();
		const res = await app.request(
			"/ops/sessions/revoke",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer valid-key",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ scope: "all" }),
			},
			baseEnv,
		);
		expect(res.status).toBe(403);
	});

	it("returns 400 when scope is user but id is missing", async () => {
		withAgentAuth();
		const app = buildApp();
		const res = await app.request(
			"/ops/sessions/revoke",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer valid-key",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ scope: "user" }),
			},
			baseEnv,
		);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.code).toBe("VALIDATION_ERROR");
	});

	it("revokes all sessions for scope all", async () => {
		withAgentAuth({ rowsAffected: 3 });
		const app = buildApp();
		const res = await app.request(
			"/ops/sessions/revoke",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer valid-key",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ scope: "all" }),
			},
			baseEnv,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.success).toBe(true);
		expect(body.revoked).toBe(3);
	});
});

describe("POST /ops/sessions/revoke — cache invalidation", () => {
	/** In-memory cache store for testing. */
	function createMockCache() {
		const store = new Map<string, string>();
		const sets = new Map<string, Set<string>>();
		return {
			store,
			sets,
			client: {
				get: vi.fn(async (key: string) => store.get(key) ?? null),
				set: vi.fn(async (key: string, val: string) => {
					store.set(key, val);
				}),
				del: vi.fn(async (...keys: string[]) => {
					let removed = 0;
					for (const k of keys) {
						if (store.delete(k)) removed++;
						if (sets.delete(k)) removed++;
					}
					return removed;
				}),
				incr: vi.fn(async () => 1),
				expire: vi.fn(async () => true),
				sadd: vi.fn(async (key: string, ...members: string[]) => {
					const existing = sets.get(key);
					const s = existing ?? new Set<string>();
					if (!existing) sets.set(key, s);
					let added = 0;
					for (const m of members) {
						if (!s.has(m)) {
							s.add(m);
							added++;
						}
					}
					return added;
				}),
				srem: vi.fn(async (key: string, ...members: string[]) => {
					const s = sets.get(key);
					if (!s) return 0;
					let removed = 0;
					for (const m of members) {
						if (s.delete(m)) removed++;
					}
					return removed;
				}),
				scard: vi.fn(async (key: string) => sets.get(key)?.size ?? 0),
				smembers: vi.fn(async (key: string) => [...(sets.get(key) ?? [])]),
			},
		};
	}

	function buildAppWithCache(
		cache: ReturnType<typeof createMockCache>["client"],
	) {
		const router = createOpsRouter({
			createCacheClient: () => cache,
		});
		const app = new Hono<AppEnv>();
		app.route("/ops", router);
		return app;
	}

	beforeEach(() => {
		mockExecute.mockReset();
	});

	it("scope=all invalidates all session and user_sessions keys", async () => {
		const mock = createMockCache();
		// Seed cache: 2 users, each with 1 session
		mock.sets.set("user_sessions:1", new Set(["s1"]));
		mock.sets.set("user_sessions:2", new Set(["s2"]));
		mock.store.set("session:s1", JSON.stringify({ userId: 1 }));
		mock.store.set("session:s2", JSON.stringify({ userId: 2 }));

		// Mock chain: agent auth → SELECT DISTINCT user_id → UPDATE
		withAgentAuth(
			{ rows: [{ user_id: 1 }, { user_id: 2 }] },
			{ rowsAffected: 2 },
		);
		const app = buildAppWithCache(mock.client);
		const res = await app.request(
			"/ops/sessions/revoke",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer valid-key",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ scope: "all" }),
			},
			baseEnv,
		);

		expect(res.status).toBe(200);
		expect(mock.store.has("session:s1")).toBe(false);
		expect(mock.store.has("session:s2")).toBe(false);
		expect(mock.sets.has("user_sessions:1")).toBe(false);
		expect(mock.sets.has("user_sessions:2")).toBe(false);
	});

	it("scope=user invalidates that user's sessions", async () => {
		const mock = createMockCache();
		mock.sets.set("user_sessions:1", new Set(["s1", "s1b"]));
		mock.store.set("session:s1", JSON.stringify({ userId: 1 }));
		mock.store.set("session:s1b", JSON.stringify({ userId: 1 }));

		withAgentAuth({ rowsAffected: 2 });
		const app = buildAppWithCache(mock.client);
		const res = await app.request(
			"/ops/sessions/revoke",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer valid-key",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ scope: "user", id: 1 }),
			},
			baseEnv,
		);

		expect(res.status).toBe(200);
		expect(mock.store.has("session:s1")).toBe(false);
		expect(mock.store.has("session:s1b")).toBe(false);
		expect(mock.sets.has("user_sessions:1")).toBe(false);
	});

	it("scope=session invalidates single session and removes from user_sessions", async () => {
		const mock = createMockCache();
		mock.sets.set("user_sessions:1", new Set(["s1"]));
		mock.store.set("session:s1", JSON.stringify({ userId: 1 }));

		withAgentAuth({ rowsAffected: 1 });
		const app = buildAppWithCache(mock.client);
		const res = await app.request(
			"/ops/sessions/revoke",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer valid-key",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ scope: "session", id: "s1" }),
			},
			baseEnv,
		);

		expect(res.status).toBe(200);
		expect(mock.store.has("session:s1")).toBe(false);
		expect(mock.sets.get("user_sessions:1")?.has("s1")).toBe(false);
	});

	it("scope=session keeps other sessions in user_sessions set", async () => {
		const mock = createMockCache();
		mock.sets.set("user_sessions:1", new Set(["s1", "s2"]));
		mock.store.set("session:s1", JSON.stringify({ userId: 1 }));
		mock.store.set("session:s2", JSON.stringify({ userId: 1 }));

		withAgentAuth({ rowsAffected: 1 });
		const app = buildAppWithCache(mock.client);
		const res = await app.request(
			"/ops/sessions/revoke",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer valid-key",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ scope: "session", id: "s1" }),
			},
			baseEnv,
		);

		expect(res.status).toBe(200);
		expect(mock.store.has("session:s1")).toBe(false);
		// Other session remains
		expect(mock.sets.get("user_sessions:1")?.has("s2")).toBe(true);
	});
});

describe("GET /ops/sessions", () => {
	beforeEach(() => {
		mockExecute.mockReset();
	});

	it("returns sessions for authenticated agent", async () => {
		withAgentAuth({
			rows: [
				{
					id: "s1",
					user_id: 1,
					ip_address: "1.2.3.4",
					user_agent: "Test",
					created_at: "2026-01-01",
					expires_at: "2026-02-01",
				},
			],
		});
		const app = buildApp();
		const res = await app.request(
			"/ops/sessions",
			{ headers: { Authorization: "Bearer valid-key" } },
			baseEnv,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.sessions).toHaveLength(1);
		expect(body.count).toBe(1);
	});

	it("passes user_id filter to SQL", async () => {
		withAgentAuth({ rows: [] });
		const app = buildApp();
		const res = await app.request(
			"/ops/sessions?user_id=42",
			{ headers: { Authorization: "Bearer valid-key" } },
			baseEnv,
		);
		expect(res.status).toBe(200);
		const lastCall = mockExecute.mock.calls[mockExecute.mock.calls.length - 1];
		expect(lastCall[0].args).toContain(42);
	});

	it("respects active=false query parameter", async () => {
		withAgentAuth({ rows: [] });
		const app = buildApp();
		const res = await app.request(
			"/ops/sessions?active=false",
			{ headers: { Authorization: "Bearer valid-key" } },
			baseEnv,
		);
		expect(res.status).toBe(200);
		const lastCall = mockExecute.mock.calls[mockExecute.mock.calls.length - 1];
		expect(lastCall[0].sql).not.toContain("expires_at > datetime");
	});

	it("returns 500 on database error", async () => {
		withAgentAuth();
		mockExecute.mockRejectedValueOnce(new Error("DB unavailable"));
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const app = buildApp();
		const res = await app.request(
			"/ops/sessions",
			{ headers: { Authorization: "Bearer valid-key" } },
			baseEnv,
		);
		expect(res.status).toBe(500);
		const body = await res.json();
		expect(body.code).toBe("INTERNAL_ERROR");
		consoleSpy.mockRestore();
	});

	it("returns 401 without auth", async () => {
		const app = buildApp();
		const res = await app.request("/ops/sessions", {}, baseEnv);
		expect(res.status).toBe(401);
	});
});

describe("GET /ops/events — actor_id filter", () => {
	beforeEach(() => {
		mockExecute.mockReset();
	});

	it("passes user_id filter to SQL query", async () => {
		withAgentAuth({ rows: [] });
		const app = buildApp();
		const res = await app.request(
			"/ops/events?user_id=7",
			{ headers: { Authorization: "Bearer valid-key" } },
			baseEnv,
		);
		expect(res.status).toBe(200);
		const lastCall = mockExecute.mock.calls[mockExecute.mock.calls.length - 1];
		expect(lastCall[0].args).toContain(7);
	});

	it("passes ip filter to SQL query", async () => {
		withAgentAuth({ rows: [] });
		const app = buildApp();
		const res = await app.request(
			"/ops/events?ip=10.0.0.1",
			{ headers: { Authorization: "Bearer valid-key" } },
			baseEnv,
		);
		expect(res.status).toBe(200);
		const lastCall = mockExecute.mock.calls[mockExecute.mock.calls.length - 1];
		expect(lastCall[0].args).toContain("10.0.0.1");
	});

	it("passes type filter to SQL query", async () => {
		withAgentAuth({ rows: [] });
		const app = buildApp();
		const res = await app.request(
			"/ops/events?type=login.failure",
			{ headers: { Authorization: "Bearer valid-key" } },
			baseEnv,
		);
		expect(res.status).toBe(200);
		const lastCall = mockExecute.mock.calls[mockExecute.mock.calls.length - 1];
		expect(lastCall[0].args).toContain("login.failure");
	});

	it("passes actor_id filter to SQL query", async () => {
		withAgentAuth({
			rows: [
				{
					id: 1,
					type: "login.success",
					actor_id: "app:test",
					created_at: "2026-01-01",
				},
			],
		});
		const app = buildApp();
		const res = await app.request(
			"/ops/events?actor_id=app:test",
			{ headers: { Authorization: "Bearer valid-key" } },
			baseEnv,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.events).toHaveLength(1);
		// Verify actor_id was passed as a SQL arg
		const lastExecuteCall =
			mockExecute.mock.calls[mockExecute.mock.calls.length - 1];
		expect(lastExecuteCall[0].args).toContain("app:test");
	});
});

describe("GET /ops/events — DB error", () => {
	beforeEach(() => {
		mockExecute.mockReset();
	});

	it("returns 500 on database error", async () => {
		withAgentAuth();
		mockExecute.mockRejectedValueOnce(new Error("DB unavailable"));
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const app = buildApp();
		const res = await app.request(
			"/ops/events",
			{ headers: { Authorization: "Bearer valid-key" } },
			baseEnv,
		);
		expect(res.status).toBe(500);
		const body = await res.json();
		expect(body.code).toBe("INTERNAL_ERROR");
		consoleSpy.mockRestore();
	});
});

describe("GET /ops/events/stats", () => {
	beforeEach(() => {
		mockExecute.mockReset();
	});

	it("returns stats for authenticated agent", async () => {
		withAgentAuth({
			rows: [
				{ type: "login.success", count: 10 },
				{ type: "login.failure", count: 3 },
			],
		});
		const app = buildApp();
		const res = await app.request(
			"/ops/events/stats",
			{ headers: { Authorization: "Bearer valid-key" } },
			baseEnv,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.stats["login.success"]).toBe(10);
		expect(body.stats["login.failure"]).toBe(3);
		expect(body.since).toBeDefined();
	});

	it("returns 401 without auth", async () => {
		const app = buildApp();
		const res = await app.request("/ops/events/stats", {}, baseEnv);
		expect(res.status).toBe(401);
	});

	it("returns 500 on database error", async () => {
		withAgentAuth();
		mockExecute.mockRejectedValueOnce(new Error("DB unavailable"));
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const app = buildApp();
		const res = await app.request(
			"/ops/events/stats",
			{ headers: { Authorization: "Bearer valid-key" } },
			baseEnv,
		);
		expect(res.status).toBe(500);
		const body = await res.json();
		expect(body.code).toBe("INTERNAL_ERROR");
		consoleSpy.mockRestore();
	});
});

describe("POST /ops/agents — error paths", () => {
	beforeEach(() => {
		mockExecute.mockReset();
		mockEnsureSchema.mockReset();
		(timingSafeEqual as ReturnType<typeof vi.fn>).mockReset();
	});

	it("returns 409 when agent name already exists", async () => {
		(timingSafeEqual as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		mockExecute.mockRejectedValue(new Error("UNIQUE constraint failed"));
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const app = buildApp();
		const res = await app.request(
			"/ops/agents",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-provisioning-secret": "test-secret",
				},
				body: JSON.stringify({ name: "existing-agent" }),
			},
			baseEnv,
		);
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body.code).toBe("AGENT_EXISTS");
		consoleSpy.mockRestore();
	});
});

describe("DELETE /ops/agents/:name — error paths", () => {
	beforeEach(() => {
		mockExecute.mockReset();
		(timingSafeEqual as ReturnType<typeof vi.fn>).mockReset();
	});

	it("returns 404 when agent not found", async () => {
		(timingSafeEqual as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		mockExecute.mockResolvedValue({ rowsAffected: 0 });
		const app = buildApp();
		const res = await app.request(
			"/ops/agents/nonexistent",
			{
				method: "DELETE",
				headers: { "x-provisioning-secret": "test-secret" },
			},
			baseEnv,
		);
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.code).toBe("NOT_FOUND");
	});

	it("returns 401 with wrong provisioning secret", async () => {
		(timingSafeEqual as ReturnType<typeof vi.fn>).mockResolvedValue(false);
		const app = buildApp();
		const res = await app.request(
			"/ops/agents/test-agent",
			{
				method: "DELETE",
				headers: { "x-provisioning-secret": "wrong-secret" },
			},
			baseEnv,
		);
		expect(res.status).toBe(401);
	});
});

describe("GET /ops/agents — error paths", () => {
	beforeEach(() => {
		mockExecute.mockReset();
	});

	it("returns 500 on database error", async () => {
		withAgentAuth();
		mockExecute.mockRejectedValueOnce(new Error("DB unavailable"));
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const app = buildApp();
		const res = await app.request(
			"/ops/agents",
			{ headers: { Authorization: "Bearer valid-key" } },
			baseEnv,
		);
		expect(res.status).toBe(500);
		const body = await res.json();
		expect(body.code).toBe("INTERNAL_ERROR");
		consoleSpy.mockRestore();
	});
});

describe("POST /ops/sessions/revoke — validation", () => {
	beforeEach(() => {
		mockExecute.mockReset();
	});

	it("returns 400 for invalid body schema", async () => {
		withAgentAuth();
		const app = buildApp();
		const res = await app.request(
			"/ops/sessions/revoke",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer valid-key",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ scope: "invalid-scope" }),
			},
			baseEnv,
		);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe("Invalid body");
	});

	it("returns 500 when revocation SQL fails", async () => {
		withAgentAuth();
		mockExecute.mockRejectedValueOnce(new Error("SQL write failed"));
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const app = buildApp();
		const res = await app.request(
			"/ops/sessions/revoke",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer valid-key",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ scope: "all" }),
			},
			baseEnv,
		);
		expect(res.status).toBe(500);
		const body = await res.json();
		expect(body.code).toBe("REVOCATION_ERROR");
		consoleSpy.mockRestore();
	});
});

describe("ops route event emission", () => {
	beforeEach(() => {
		mockExecute.mockReset();
		mockEnsureSchema.mockReset();
		mockProcessEvent.mockReset().mockResolvedValue(undefined);
		(timingSafeEqual as ReturnType<typeof vi.fn>).mockReset();
	});

	it("POST /ops/sessions/revoke emits session.ops_revoke", async () => {
		withAgentAuth({ rowsAffected: 1 });
		const app = buildApp();
		const res = await app.request(
			"/ops/sessions/revoke",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer valid-key",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ scope: "all" }),
			},
			baseEnv,
		);
		expect(res.status).toBe(200);
		await vi.waitFor(() => {
			expect(mockProcessEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "session.ops_revoke",
					actorId: "agent:test-agent",
				}),
				expect.anything(),
			);
		});
	});

	it("POST /ops/agents emits agent.provisioned", async () => {
		(timingSafeEqual as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		mockExecute.mockResolvedValue({ rows: [], rowsAffected: 1 });
		const app = buildApp();
		const res = await app.request(
			"/ops/agents",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-provisioning-secret": "test-secret",
				},
				body: JSON.stringify({ name: "new-agent" }),
			},
			baseEnv,
		);
		expect(res.status).toBe(200);
		await vi.waitFor(() => {
			expect(mockProcessEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "agent.provisioned",
					actorId: "app:private-landing",
				}),
				expect.anything(),
			);
		});
	});

	it("DELETE /ops/agents/:name emits agent.revoked", async () => {
		(timingSafeEqual as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		mockExecute.mockResolvedValue({ rowsAffected: 1 });
		const app = buildApp();
		const res = await app.request(
			"/ops/agents/test-agent",
			{
				method: "DELETE",
				headers: { "x-provisioning-secret": "test-secret" },
			},
			baseEnv,
		);
		expect(res.status).toBe(200);
		await vi.waitFor(() => {
			expect(mockProcessEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "agent.revoked",
					actorId: "app:private-landing",
				}),
				expect.anything(),
			);
		});
	});
});
