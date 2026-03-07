/**
 * @file events.test.ts
 * Integration tests for observability plugin event emission.
 * Plugin-only — delete this directory when removing packages/observability.
 *
 * @license Apache-2.0
 */

import { env } from "cloudflare:test";
import type { SqliteClient } from "@private-landing/infrastructure";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	cleanupSecurityEvents,
	cleanupSuiteUser,
	createCredentialsFormData,
	createSuiteUser,
	initTestDb,
	loginAndGetCookies,
	makeAuthenticatedRequest,
	makeRequest,
	TEST_USER,
} from "../../../fixtures/mock-env";

const SUITE_EMAIL = "obs-events-suite@example.com";

let dbClient: SqliteClient;
let agentKey: string;

/**
 * Provision a test agent via /ops/agents.
 * Requires AGENT_PROVISIONING_SECRET in the worker environment.
 */
async function provisionTestAgent(): Promise<string> {
	const secret = env.AGENT_PROVISIONING_SECRET;
	if (!secret) {
		throw new Error(
			"AGENT_PROVISIONING_SECRET not set — cannot provision test agent",
		);
	}

	const name = `test-events-${Date.now()}`;
	const res = await makeRequest("/ops/agents", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-provisioning-secret": secret,
		},
		body: JSON.stringify({ name, trustLevel: "read" }),
	});

	if (!res.ok) {
		throw new Error(`Agent provisioning failed: ${res.status}`);
	}

	const body = (await res.json()) as { apiKey: string };
	return body.apiKey;
}

/** Poll /ops/events for a specific event type via the API. */
async function pollForEvent(type: string, maxAttempts = 10): Promise<boolean> {
	const since = new Date(Date.now() - 60_000).toISOString();
	for (let i = 0; i < maxAttempts; i++) {
		const res = await makeRequest(
			`/ops/events?type=${encodeURIComponent(type)}&since=${encodeURIComponent(since)}`,
			{
				headers: {
					Authorization: `Bearer ${agentKey}`,
					Accept: "application/json",
				},
			},
		);
		if (res.ok) {
			const body = (await res.json()) as { events: unknown[]; count: number };
			if (body.count > 0) return true;
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	return false;
}

describe("[obs-plugin] event emission", () => {
	beforeAll(async () => {
		dbClient = await initTestDb();
		await createSuiteUser(dbClient, SUITE_EMAIL);
		agentKey = await provisionTestAgent();
	});

	afterAll(async () => {
		await cleanupSecurityEvents(dbClient);
		await cleanupSuiteUser(dbClient, SUITE_EMAIL);
		await dbClient.execute(
			"DELETE FROM account WHERE email LIKE 'obs-reg-%@example.com'",
		);
		await dbClient.execute(
			"DELETE FROM agent_credential WHERE name LIKE 'test-events-%'",
		);
		dbClient.close();
	});

	it("stores registration.success event after successful registration", async () => {
		await cleanupSecurityEvents(dbClient);

		const formData = createCredentialsFormData(
			`obs-reg-success-${Date.now()}@example.com`,
			"SecurePassword123!",
		);
		await makeRequest("/auth/register", {
			method: "POST",
			body: formData,
			headers: { Accept: "application/json" },
		});

		expect(await pollForEvent("registration.success")).toBe(true);
	});

	it("stores registration.failure event after failed registration", async () => {
		await cleanupSecurityEvents(dbClient);

		const formData = createCredentialsFormData("not-an-email", "short");
		await makeRequest("/auth/register", {
			method: "POST",
			body: formData,
			headers: { Accept: "application/json" },
		});

		expect(await pollForEvent("registration.failure")).toBe(true);
	});

	it("stores login.failure event after failed login", async () => {
		await cleanupSecurityEvents(dbClient);

		const formData = createCredentialsFormData(SUITE_EMAIL, "wrong-password");
		await makeRequest("/auth/login", {
			method: "POST",
			body: formData,
			headers: { Accept: "application/json" },
		});

		expect(await pollForEvent("login.failure")).toBe(true);
	});

	it("stores login.success event after successful login", async () => {
		await cleanupSecurityEvents(dbClient);

		const formData = createCredentialsFormData(SUITE_EMAIL, TEST_USER.password);
		await makeRequest("/auth/login", {
			method: "POST",
			body: formData,
			headers: { Accept: "application/json" },
		});

		expect(await pollForEvent("login.success")).toBe(true);
	});

	it("stores session.revoke event after logout", async () => {
		await cleanupSecurityEvents(dbClient);

		const cookies = await loginAndGetCookies(dbClient, SUITE_EMAIL);
		await cleanupSecurityEvents(dbClient);

		await makeAuthenticatedRequest("/auth/logout", cookies, {
			method: "POST",
			headers: { Accept: "application/json" },
		});

		expect(await pollForEvent("session.revoke")).toBe(true);
	});

	it("stores password.change event after password change", async () => {
		await cleanupSecurityEvents(dbClient);

		const cookies = await loginAndGetCookies(dbClient, SUITE_EMAIL);
		await cleanupSecurityEvents(dbClient);

		await makeAuthenticatedRequest("/account/password", cookies, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				currentPassword: TEST_USER.password,
				newPassword: "NewTest456!@#",
			}),
		});

		expect(await pollForEvent("password.change")).toBe(true);
	});
});
