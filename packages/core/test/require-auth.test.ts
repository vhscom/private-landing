/**
 * @file require-auth.test.ts
 * Unit tests for authentication middleware.
 *
 * @license Apache-2.0
 */

import type { TokenPayload } from "@private-landing/types";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { describe, expect, it, vi } from "vitest";
import { createRequireAuth } from "../src/auth/middleware/require-auth";

const TEST_ACCESS_SECRET = "test-access-secret-key-minimum-32-chars";
const TEST_REFRESH_SECRET = "test-refresh-secret-key-minimum-32-chars";

async function createAccessToken(
	payload: Omit<TokenPayload, "typ">,
): Promise<string> {
	return sign({ ...payload, typ: "access" }, TEST_ACCESS_SECRET);
}

async function createRefreshToken(
	payload: Omit<TokenPayload, "typ">,
): Promise<string> {
	return sign({ ...payload, typ: "refresh" }, TEST_REFRESH_SECRET);
}

function createMockServices(options: {
	sessionExists?: boolean;
	sessionId?: string;
	newAccessToken?: string;
}) {
	const {
		sessionExists = true,
		sessionId = "test-session",
		newAccessToken = "new-access-token",
	} = options;

	return {
		sessionService: {
			getSession: vi
				.fn()
				.mockResolvedValue(sessionExists ? { id: sessionId } : null),
			createSession: vi.fn(),
			endSession: vi.fn(),
			cleanupExpiredSessions: vi.fn(),
		},
		tokenService: {
			generateTokens: vi.fn(),
			refreshAccessToken: vi.fn().mockResolvedValue(newAccessToken),
		},
	};
}

describe("createRequireAuth", () => {
	describe("valid access token", () => {
		it("should allow request with valid access token and session", async () => {
			const services = createMockServices({ sessionId: "session-123" });
			const middleware = createRequireAuth(services);

			const app = new Hono<{
				Bindings: { JWT_ACCESS_SECRET: string; JWT_REFRESH_SECRET: string };
			}>();
			app.use("*", middleware);
			app.get("/protected", (c) => c.json({ ok: true }));

			const accessToken = await createAccessToken({
				uid: 1,
				sid: "session-123",
				exp: Math.floor(Date.now() / 1000) + 3600,
			});

			const res = await app.request(
				"/protected",
				{
					headers: {
						Cookie: `access_token=${accessToken}`,
					},
				},
				{
					JWT_ACCESS_SECRET: TEST_ACCESS_SECRET,
					JWT_REFRESH_SECRET: TEST_REFRESH_SECRET,
				},
			);

			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toEqual({ ok: true });
		});

		it("should call next() and continue to handler", async () => {
			const services = createMockServices({ sessionId: "session-abc" });
			const middleware = createRequireAuth(services);

			const app = new Hono<{
				Bindings: { JWT_ACCESS_SECRET: string; JWT_REFRESH_SECRET: string };
			}>();
			app.use("*", middleware);
			app.get("/data", (c) => c.json({ data: "secret" }));

			const accessToken = await createAccessToken({
				uid: 42,
				sid: "session-abc",
				exp: Math.floor(Date.now() / 1000) + 3600,
			});

			const res = await app.request(
				"/data",
				{
					headers: {
						Cookie: `access_token=${accessToken}`,
					},
				},
				{
					JWT_ACCESS_SECRET: TEST_ACCESS_SECRET,
					JWT_REFRESH_SECRET: TEST_REFRESH_SECRET,
				},
			);

			expect(res.status).toBe(200);
			expect(services.sessionService.getSession).toHaveBeenCalled();
		});
	});

	describe("invalid access token", () => {
		it("should reject request with no tokens", async () => {
			const services = createMockServices({});
			const middleware = createRequireAuth(services);

			const app = new Hono<{
				Bindings: { JWT_ACCESS_SECRET: string; JWT_REFRESH_SECRET: string };
			}>();
			app.use("*", middleware);
			app.get("/protected", (c) => c.json({ ok: true }));

			const res = await app.request(
				"/protected",
				{},
				{
					JWT_ACCESS_SECRET: TEST_ACCESS_SECRET,
					JWT_REFRESH_SECRET: TEST_REFRESH_SECRET,
				},
			);

			expect(res.status).toBe(401);
			const body = await res.json();
			expect(body.code).toBe("TOKEN_EXPIRED");
		});

		it("should reject request with malformed access token", async () => {
			const services = createMockServices({});
			const middleware = createRequireAuth(services);

			const app = new Hono<{
				Bindings: { JWT_ACCESS_SECRET: string; JWT_REFRESH_SECRET: string };
			}>();
			app.use("*", middleware);
			app.get("/protected", (c) => c.json({ ok: true }));

			const res = await app.request(
				"/protected",
				{
					headers: {
						Cookie: "access_token=invalid-token",
					},
				},
				{
					JWT_ACCESS_SECRET: TEST_ACCESS_SECRET,
					JWT_REFRESH_SECRET: TEST_REFRESH_SECRET,
				},
			);

			expect(res.status).toBe(401);
		});

		it("should reject when session does not match token", async () => {
			const services = createMockServices({
				sessionExists: true,
				sessionId: "different-session",
			});
			const middleware = createRequireAuth(services);

			const app = new Hono<{
				Bindings: { JWT_ACCESS_SECRET: string; JWT_REFRESH_SECRET: string };
			}>();
			app.use("*", middleware);
			app.get("/protected", (c) => c.json({ ok: true }));

			const accessToken = await createAccessToken({
				uid: 1,
				sid: "original-session",
				exp: Math.floor(Date.now() / 1000) + 3600,
			});

			const res = await app.request(
				"/protected",
				{
					headers: {
						Cookie: `access_token=${accessToken}`,
					},
				},
				{
					JWT_ACCESS_SECRET: TEST_ACCESS_SECRET,
					JWT_REFRESH_SECRET: TEST_REFRESH_SECRET,
				},
			);

			expect(res.status).toBe(401);
		});

		it("should reject when session does not exist", async () => {
			const services = createMockServices({ sessionExists: false });
			const middleware = createRequireAuth(services);

			const app = new Hono<{
				Bindings: { JWT_ACCESS_SECRET: string; JWT_REFRESH_SECRET: string };
			}>();
			app.use("*", middleware);
			app.get("/protected", (c) => c.json({ ok: true }));

			const accessToken = await createAccessToken({
				uid: 1,
				sid: "nonexistent-session",
				exp: Math.floor(Date.now() / 1000) + 3600,
			});

			const res = await app.request(
				"/protected",
				{
					headers: {
						Cookie: `access_token=${accessToken}`,
					},
				},
				{
					JWT_ACCESS_SECRET: TEST_ACCESS_SECRET,
					JWT_REFRESH_SECRET: TEST_REFRESH_SECRET,
				},
			);

			expect(res.status).toBe(401);
		});
	});

	describe("refresh token flow", () => {
		it("should refresh access token when access token is expired", async () => {
			const newToken = await createAccessToken({
				uid: 1,
				sid: "session-123",
				exp: Math.floor(Date.now() / 1000) + 3600,
			});

			const services = createMockServices({
				sessionId: "session-123",
				newAccessToken: newToken,
			});
			const middleware = createRequireAuth(services);

			const app = new Hono<{
				Bindings: { JWT_ACCESS_SECRET: string; JWT_REFRESH_SECRET: string };
			}>();
			app.use("*", middleware);
			app.get("/protected", (c) => c.json({ ok: true }));

			const refreshToken = await createRefreshToken({
				uid: 1,
				sid: "session-123",
				exp: Math.floor(Date.now() / 1000) + 86400,
			});

			const res = await app.request(
				"/protected",
				{
					headers: {
						Cookie: `refresh_token=${refreshToken}`,
					},
				},
				{
					JWT_ACCESS_SECRET: TEST_ACCESS_SECRET,
					JWT_REFRESH_SECRET: TEST_REFRESH_SECRET,
				},
			);

			expect(res.status).toBe(200);
			expect(services.tokenService.refreshAccessToken).toHaveBeenCalled();
		});

		it("should reject when refresh token session is revoked", async () => {
			const services = createMockServices({
				sessionExists: false,
			});
			const middleware = createRequireAuth(services);

			const app = new Hono<{
				Bindings: { JWT_ACCESS_SECRET: string; JWT_REFRESH_SECRET: string };
			}>();
			app.use("*", middleware);
			app.get("/protected", (c) => c.json({ ok: true }));

			const refreshToken = await createRefreshToken({
				uid: 1,
				sid: "revoked-session",
				exp: Math.floor(Date.now() / 1000) + 86400,
			});

			const res = await app.request(
				"/protected",
				{
					headers: {
						Cookie: `refresh_token=${refreshToken}`,
					},
				},
				{
					JWT_ACCESS_SECRET: TEST_ACCESS_SECRET,
					JWT_REFRESH_SECRET: TEST_REFRESH_SECRET,
				},
			);

			expect(res.status).toBe(403);
			const body = await res.json();
			expect(body.code).toBe("SESSION_REVOKED");
		});

		it("should reject when refresh token is malformed", async () => {
			const services = createMockServices({});
			const middleware = createRequireAuth(services);

			const app = new Hono<{
				Bindings: { JWT_ACCESS_SECRET: string; JWT_REFRESH_SECRET: string };
			}>();
			app.use("*", middleware);
			app.get("/protected", (c) => c.json({ ok: true }));

			const res = await app.request(
				"/protected",
				{
					headers: {
						Cookie: "refresh_token=invalid-refresh-token",
					},
				},
				{
					JWT_ACCESS_SECRET: TEST_ACCESS_SECRET,
					JWT_REFRESH_SECRET: TEST_REFRESH_SECRET,
				},
			);

			expect(res.status).toBe(400);
			const body = await res.json();
			expect(body.code).toBe("TOKEN_MALFORMED");
		});
	});

	describe("token type validation", () => {
		it("should reject refresh token used as access token", async () => {
			const services = createMockServices({ sessionId: "session-123" });
			const middleware = createRequireAuth(services);

			const app = new Hono<{
				Bindings: { JWT_ACCESS_SECRET: string; JWT_REFRESH_SECRET: string };
			}>();
			app.use("*", middleware);
			app.get("/protected", (c) => c.json({ ok: true }));

			// Create a token with type "refresh" but sign with access secret
			const wrongTypeToken = await sign(
				{
					uid: 1,
					sid: "session-123",
					typ: "refresh",
					exp: Math.floor(Date.now() / 1000) + 3600,
				},
				TEST_ACCESS_SECRET,
			);

			const res = await app.request(
				"/protected",
				{
					headers: {
						Cookie: `access_token=${wrongTypeToken}`,
					},
				},
				{
					JWT_ACCESS_SECRET: TEST_ACCESS_SECRET,
					JWT_REFRESH_SECRET: TEST_REFRESH_SECRET,
				},
			);

			expect(res.status).toBe(401);
		});

		it("should reject access token used as refresh token", async () => {
			const services = createMockServices({});
			const middleware = createRequireAuth(services);

			const app = new Hono<{
				Bindings: { JWT_ACCESS_SECRET: string; JWT_REFRESH_SECRET: string };
			}>();
			app.use("*", middleware);
			app.get("/protected", (c) => c.json({ ok: true }));

			// Create a token with type "access" but sign with refresh secret
			const wrongTypeToken = await sign(
				{
					uid: 1,
					sid: "session-123",
					typ: "access",
					exp: Math.floor(Date.now() / 1000) + 3600,
				},
				TEST_REFRESH_SECRET,
			);

			const res = await app.request(
				"/protected",
				{
					headers: {
						Cookie: `refresh_token=${wrongTypeToken}`,
					},
				},
				{
					JWT_ACCESS_SECRET: TEST_ACCESS_SECRET,
					JWT_REFRESH_SECRET: TEST_REFRESH_SECRET,
				},
			);

			expect(res.status).toBe(400);
		});
	});

	describe("error handling", () => {
		it("should return 401 for unknown errors", async () => {
			const services = createMockServices({ sessionId: "session-123" });
			// Make getSession throw on second call (during refresh flow)
			services.sessionService.getSession
				.mockResolvedValueOnce(null) // First call for access token check
				.mockRejectedValueOnce(new Error("Database error")); // Fail during refresh

			const middleware = createRequireAuth(services);

			const app = new Hono<{
				Bindings: { JWT_ACCESS_SECRET: string; JWT_REFRESH_SECRET: string };
			}>();
			app.use("*", middleware);
			app.get("/protected", (c) => c.json({ ok: true }));

			const refreshToken = await createRefreshToken({
				uid: 1,
				sid: "session-123",
				exp: Math.floor(Date.now() / 1000) + 86400,
			});

			const res = await app.request(
				"/protected",
				{
					headers: {
						Cookie: `refresh_token=${refreshToken}`,
					},
				},
				{
					JWT_ACCESS_SECRET: TEST_ACCESS_SECRET,
					JWT_REFRESH_SECRET: TEST_REFRESH_SECRET,
				},
			);

			expect(res.status).toBe(403);
			const body = await res.json();
			expect(body.code).toBe("SESSION_REVOKED");
		});
	});
});
