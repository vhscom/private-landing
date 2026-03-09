/**
 * @file ops-api.test.ts
 * Integration tests for the /ops API surface (agent lifecycle, sessions, events).
 * Plugin-only — delete this directory when removing packages/observability.
 *
 * @license Apache-2.0
 */

import { env } from "cloudflare:test";
import type { SqliteClient } from "@private-landing/infrastructure";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	cleanupSuiteUser,
	createSuiteUser,
	initTestDb,
	loginAndGetCookies,
	makeAuthenticatedRequest,
	makeRequest,
	TEST_USER,
} from "../../../fixtures/mock-env";

const SUITE_EMAIL = "ops-api-suite@example.com";
const AGENT_PREFIX = "test-ops-api";

let dbClient: SqliteClient;
let agentKey: string;
let suiteUserId: number;

async function provisionAgent(
	name: string,
	trustLevel: "read" | "write" = "read",
): Promise<string> {
	const secret = env.AGENT_PROVISIONING_SECRET;
	if (!secret) throw new Error("AGENT_PROVISIONING_SECRET not set");

	const res = await makeRequest("/ops/agents", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-provisioning-secret": secret,
		},
		body: JSON.stringify({ name, trustLevel }),
	});
	if (!res.ok) throw new Error(`Agent provisioning failed: ${res.status}`);
	return ((await res.json()) as { apiKey: string }).apiKey;
}

async function revokeAgent(name: string): Promise<Response> {
	return makeRequest(`/ops/agents/${name}`, {
		method: "DELETE",
		headers: { "x-provisioning-secret": env.AGENT_PROVISIONING_SECRET ?? "" },
	});
}

/** Poll /ops/events for a specific event type via the API. */
async function pollForEvent(
	type: string,
	opts: { userId?: number; maxAttempts?: number } = {},
): Promise<{ found: boolean; events: Record<string, unknown>[] }> {
	const maxAttempts = opts.maxAttempts ?? 15;
	const since = new Date(Date.now() - 60_000).toISOString();
	let url = `/ops/events?type=${encodeURIComponent(type)}&since=${encodeURIComponent(since)}`;
	if (opts.userId !== undefined) url += `&user_id=${opts.userId}`;

	for (let i = 0; i < maxAttempts; i++) {
		const res = await makeRequest(url, {
			headers: {
				Authorization: `Bearer ${agentKey}`,
				Accept: "application/json",
			},
		});
		if (res.ok) {
			const body = (await res.json()) as {
				events: Record<string, unknown>[];
				count: number;
			};
			if (body.count > 0) return { found: true, events: body.events };
		}
		await new Promise((r) => setTimeout(r, 300));
	}
	return { found: false, events: [] };
}

/** Scoped cleanup — only events from this suite's user or agents. */
async function cleanupSuiteEvents(): Promise<void> {
	try {
		await dbClient.execute({
			sql: "DELETE FROM security_event WHERE user_id = ? OR actor_id LIKE ?",
			args: [suiteUserId, `%${AGENT_PREFIX}%`],
		});
	} catch {
		// Table may not exist yet
	}
}

describe("[obs-plugin] ops API surface", () => {
	beforeAll(async () => {
		dbClient = await initTestDb();
		// Clean up stale agents from previous failed runs
		// Table may not exist yet (created lazily by ensureSchema)
		try {
			await dbClient.execute({
				sql: "DELETE FROM agent_credential WHERE name LIKE ?",
				args: [`${AGENT_PREFIX}%`],
			});
		} catch {
			// Table created on first agent provision
		}
		suiteUserId = await createSuiteUser(dbClient, SUITE_EMAIL);
		agentKey = await provisionAgent(`${AGENT_PREFIX}-reader`);
	});

	afterAll(async () => {
		await cleanupSuiteEvents();
		await cleanupSuiteUser(dbClient, SUITE_EMAIL);
		await dbClient.execute({
			sql: "DELETE FROM agent_credential WHERE name LIKE ?",
			args: [`${AGENT_PREFIX}%`],
		});
		dbClient.close();
	});

	describe("agent lifecycle", () => {
		const name = `${AGENT_PREFIX}-lifecycle-${Date.now()}`;

		it("provisions a new agent and lists it", async () => {
			const key = await provisionAgent(name);
			expect(key).toBeTruthy();

			const res = await makeRequest("/ops/agents", {
				headers: { Authorization: `Bearer ${agentKey}` },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				agents: { name: string }[];
			};
			expect(body.agents.map((a) => a.name)).toContain(name);
		});

		it("revokes the agent and it disappears from the list", async () => {
			const revokeRes = await revokeAgent(name);
			expect(revokeRes.status).toBe(200);

			const res = await makeRequest("/ops/agents", {
				headers: { Authorization: `Bearer ${agentKey}` },
			});
			const body = (await res.json()) as {
				agents: { name: string }[];
			};
			expect(body.agents.map((a) => a.name)).not.toContain(name);
		});
	});

	describe("agent auth enforcement", () => {
		it("returns 401 without Bearer token", async () => {
			const res = await makeRequest("/ops/agents");
			expect(res.status).toBe(401);
			const body = (await res.json()) as { code: string };
			expect(body.code).toBe("MISSING_API_KEY");
		});

		it("returns 401 with invalid Bearer token", async () => {
			const res = await makeRequest("/ops/agents", {
				headers: { Authorization: "Bearer bad-key" },
			});
			expect(res.status).toBe(401);
			const body = (await res.json()) as { code: string };
			expect(body.code).toBe("INVALID_API_KEY");
		});
	});

	describe("session query", () => {
		it("returns active sessions after login", async () => {
			await loginAndGetCookies(dbClient, SUITE_EMAIL);

			const res = await makeRequest(`/ops/sessions?user_id=${suiteUserId}`, {
				headers: { Authorization: `Bearer ${agentKey}` },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				sessions: { user_id: number }[];
				count: number;
			};
			expect(body.count).toBeGreaterThan(0);
			expect(body.sessions[0].user_id).toBe(suiteUserId);
		});
	});

	describe("event query filtering", () => {
		it("filters by ?type", async () => {
			// Provision a new agent to generate a fresh agent.provisioned event
			await provisionAgent(`${AGENT_PREFIX}-filter-${Date.now()}`);
			const { found, events } = await pollForEvent("agent.provisioned");
			expect(found).toBe(true);
			for (const e of events) expect(e.type).toBe("agent.provisioned");
		});

		it("returns empty for non-existent type", async () => {
			const since = new Date(Date.now() - 60_000).toISOString();
			const res = await makeRequest(
				`/ops/events?type=nonexistent&since=${encodeURIComponent(since)}`,
				{ headers: { Authorization: `Bearer ${agentKey}` } },
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { count: number };
			expect(body.count).toBe(0);
		});
	});

	describe("session.revoke_all on password change", () => {
		const email = `ops-api-pwd-${Date.now()}@example.com`;
		let userId: number;

		beforeAll(async () => {
			userId = await createSuiteUser(dbClient, email);
		});

		afterAll(async () => {
			await cleanupSuiteUser(dbClient, email);
			try {
				await dbClient.execute({
					sql: "DELETE FROM security_event WHERE user_id = ?",
					args: [userId],
				});
			} catch {
				/* table may not exist */
			}
		});

		it("emits both password.change and session.revoke_all", async () => {
			try {
				await dbClient.execute({
					sql: "DELETE FROM security_event WHERE user_id = ?",
					args: [userId],
				});
			} catch {
				/* table may not exist */
			}

			const cookies = await loginAndGetCookies(dbClient, email);

			// Clear events after login to isolate password change events
			try {
				await dbClient.execute({
					sql: "DELETE FROM security_event WHERE user_id = ?",
					args: [userId],
				});
			} catch {
				/* table may not exist */
			}

			await makeAuthenticatedRequest("/account/password", cookies, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify({
					currentPassword: TEST_USER.password,
					newPassword: "NewPassword456!@#",
				}),
			});

			const pwd = await pollForEvent("password.change", { userId });
			expect(pwd.found).toBe(true);

			const revoke = await pollForEvent("session.revoke_all", {
				userId,
			});
			expect(revoke.found).toBe(true);
		});
	});
});
