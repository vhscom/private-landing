/**
 * @file require-agent-key.test.ts
 * Unit tests for agent key hashing and authentication middleware.
 *
 * @license Apache-2.0
 */

import type { Env } from "@private-landing/types";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpsVariables } from "../src/require-agent-key";

const mockExecute = vi.fn();
const mockProcessEvent = vi.fn().mockResolvedValue(undefined);

vi.mock("@private-landing/infrastructure", () => ({
	createDbClient: vi.fn(() => ({ execute: mockExecute })),
}));

vi.mock("../src/process-event", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/process-event")>();
	return {
		...actual,
		processEvent: (...args: unknown[]) => mockProcessEvent(...args),
	};
});

import { hashApiKey, requireAgentKey } from "../src/require-agent-key";

type AppEnv = {
	Bindings: Env & { AGENT_PROVISIONING_SECRET?: string };
	Variables: OpsVariables;
};

const env = {
	AUTH_DB_URL: "libsql://test.turso.io",
	AUTH_DB_TOKEN: "test-token",
	JWT_ACCESS_SECRET: "test",
	JWT_REFRESH_SECRET: "test",
} as AppEnv["Bindings"];

function createApp() {
	const app = new Hono<AppEnv>();
	app.use("*", requireAgentKey);
	app.get("/test", (ctx) => {
		const principal = ctx.get("agentPrincipal");
		return ctx.json({ ok: true, agent: principal.name });
	});
	return app;
}

describe("hashApiKey", () => {
	it("returns a 64-character hex string", async () => {
		const hash = await hashApiKey("test-key");
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("produces deterministic output", async () => {
		const a = await hashApiKey("same-key");
		const b = await hashApiKey("same-key");
		expect(a).toBe(b);
	});

	it("produces different output for different inputs", async () => {
		const a = await hashApiKey("key-a");
		const b = await hashApiKey("key-b");
		expect(a).not.toBe(b);
	});
});

describe("requireAgentKey", () => {
	beforeEach(() => {
		mockExecute.mockReset();
		mockProcessEvent.mockReset().mockResolvedValue(undefined);
	});

	it("returns 401 MISSING_API_KEY when Authorization header is absent", async () => {
		const app = createApp();
		const res = await app.request("/test", {}, env);
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.code).toBe("MISSING_API_KEY");
	});

	it("returns 401 MISSING_API_KEY when header lacks Bearer prefix", async () => {
		const app = createApp();
		const res = await app.request(
			"/test",
			{ headers: { Authorization: "Basic abc123" } },
			env,
		);
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.code).toBe("MISSING_API_KEY");
	});

	it("returns 401 INVALID_API_KEY when key hash matches no credential", async () => {
		mockExecute.mockResolvedValueOnce({ rows: [] });
		const app = createApp();
		const res = await app.request(
			"/test",
			{ headers: { Authorization: "Bearer invalid-key" } },
			env,
		);
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.code).toBe("INVALID_API_KEY");
	});

	it("returns 401 INVALID_API_KEY when DB throws", async () => {
		mockExecute.mockRejectedValueOnce(new Error("DB error"));
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const app = createApp();
		const res = await app.request(
			"/test",
			{ headers: { Authorization: "Bearer some-key" } },
			env,
		);
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.code).toBe("INVALID_API_KEY");
		consoleSpy.mockRestore();
	});

	it("emits agent.auth_failure on missing key", async () => {
		const app = createApp();
		await app.request("/test", {}, env);

		expect(mockProcessEvent).toHaveBeenCalledTimes(1);
		const [event] = mockProcessEvent.mock.calls[0];
		expect(event.type).toBe("agent.auth_failure");
		expect(event.detail.code).toBe("MISSING_API_KEY");
	});

	it("emits agent.auth_failure on invalid key", async () => {
		mockExecute.mockResolvedValueOnce({ rows: [] });
		const app = createApp();
		await app.request(
			"/test",
			{ headers: { Authorization: "Bearer bad-key" } },
			env,
		);

		expect(mockProcessEvent).toHaveBeenCalledTimes(1);
		const [event] = mockProcessEvent.mock.calls[0];
		expect(event.type).toBe("agent.auth_failure");
		expect(event.detail.code).toBe("INVALID_API_KEY");
	});

	it("does not emit on successful agent auth", async () => {
		mockExecute.mockResolvedValueOnce({
			rows: [{ id: 1, name: "test-agent", trust_level: "read" }],
		});
		const app = createApp();
		await app.request(
			"/test",
			{ headers: { Authorization: "Bearer valid-key" } },
			env,
		);

		expect(mockProcessEvent).not.toHaveBeenCalled();
	});

	it("sets agentPrincipal and calls next() for valid key", async () => {
		mockExecute.mockResolvedValueOnce({
			rows: [{ id: 1, name: "test-agent", trust_level: "read" }],
		});
		const app = createApp();
		const res = await app.request(
			"/test",
			{ headers: { Authorization: "Bearer valid-key" } },
			env,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.agent).toBe("test-agent");
	});
});
