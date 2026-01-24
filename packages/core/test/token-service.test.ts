/**
 * @file token-service.test.ts
 * Unit tests for JWT token generation and management service.
 *
 * @license Apache-2.0
 */

import type { TokenPayload } from "@private-landing/types";
import { Hono } from "hono";
import { verify } from "hono/jwt";
import { beforeEach, describe, expect, it } from "vitest";
import {
	createTokenService,
	type TokenService,
} from "../src/auth/services/token-service";

// Test secrets for JWT signing
const TEST_ACCESS_SECRET = "test-access-secret-key-minimum-32-chars";
const TEST_REFRESH_SECRET = "test-refresh-secret-key-minimum-32-chars";

// Create a test app with proper environment
function createTestContext(env: Record<string, string> = {}) {
	const app = new Hono<{ Bindings: Record<string, string> }>();

	// Capture the context for testing
	// biome-ignore lint/suspicious/noExplicitAny: Test utility needs dynamic context
	let capturedCtx: any = null;

	app.get("/test", async (ctx) => {
		capturedCtx = ctx;
		return ctx.json({ ok: true });
	});

	return {
		app,
		async getContext() {
			const response = await app.request(
				"/test",
				{},
				{
					JWT_ACCESS_SECRET: TEST_ACCESS_SECRET,
					JWT_REFRESH_SECRET: TEST_REFRESH_SECRET,
					...env,
				},
			);
			await response.json(); // Ensure handler completes
			return capturedCtx;
		},
	};
}

describe("TokenService", () => {
	let tokenService: TokenService;

	beforeEach(() => {
		tokenService = createTokenService();
	});

	describe("createTokenService", () => {
		it("should create service with default config", () => {
			const service = createTokenService();
			expect(service).toBeDefined();
			expect(service.generateTokens).toBeInstanceOf(Function);
			expect(service.refreshAccessToken).toBeInstanceOf(Function);
		});

		it("should create service with custom config", () => {
			const service = createTokenService({
				accessTokenExpiry: 300, // 5 minutes
				refreshTokenExpiry: 86400, // 1 day
			});
			expect(service).toBeDefined();
		});
	});

	describe("generateTokens", () => {
		it("should generate access and refresh tokens", async () => {
			const { getContext } = createTestContext();
			const ctx = await getContext();

			const userId = 123;
			const sessionId = "test-session-id";

			const result = await tokenService.generateTokens(ctx, userId, sessionId);

			expect(result.accessToken).toBeDefined();
			expect(result.refreshToken).toBeDefined();
			expect(typeof result.accessToken).toBe("string");
			expect(typeof result.refreshToken).toBe("string");
		});

		it("should create valid access token with correct payload", async () => {
			const { getContext } = createTestContext();
			const ctx = await getContext();

			const userId = 456;
			const sessionId = "session-abc";

			const { accessToken } = await tokenService.generateTokens(
				ctx,
				userId,
				sessionId,
			);

			const payload = (await verify(
				accessToken,
				TEST_ACCESS_SECRET,
			)) as TokenPayload;

			expect(payload.uid).toBe(userId);
			expect(payload.sid).toBe(sessionId);
			expect(payload.typ).toBe("access");
			expect(payload.exp).toBeDefined();
		});

		it("should create valid refresh token with correct payload", async () => {
			const { getContext } = createTestContext();
			const ctx = await getContext();

			const userId = 789;
			const sessionId = "session-xyz";

			const { refreshToken } = await tokenService.generateTokens(
				ctx,
				userId,
				sessionId,
			);

			const payload = (await verify(
				refreshToken,
				TEST_REFRESH_SECRET,
			)) as TokenPayload;

			expect(payload.uid).toBe(userId);
			expect(payload.sid).toBe(sessionId);
			expect(payload.typ).toBe("refresh");
			expect(payload.exp).toBeDefined();
		});

		it("should set proper expiration times", async () => {
			const { getContext } = createTestContext();
			const ctx = await getContext();

			const now = Math.floor(Date.now() / 1000);
			const { accessToken, refreshToken } = await tokenService.generateTokens(
				ctx,
				1,
				"session",
			);

			const accessPayload = (await verify(
				accessToken,
				TEST_ACCESS_SECRET,
			)) as TokenPayload;
			const refreshPayload = (await verify(
				refreshToken,
				TEST_REFRESH_SECRET,
			)) as TokenPayload;

			// Access token: ~15 minutes (900 seconds)
			expect(accessPayload.exp).toBeGreaterThan(now);
			expect(accessPayload.exp).toBeLessThanOrEqual(now + 900 + 5); // 5s tolerance

			// Refresh token: ~7 days (604800 seconds)
			expect(refreshPayload.exp).toBeGreaterThan(now);
			expect(refreshPayload.exp).toBeLessThanOrEqual(now + 604800 + 5);
		});

		it("should throw error when access secret is missing", async () => {
			const { getContext } = createTestContext({
				JWT_ACCESS_SECRET: "",
				JWT_REFRESH_SECRET: TEST_REFRESH_SECRET,
			});
			const ctx = await getContext();

			await expect(
				tokenService.generateTokens(ctx, 1, "session"),
			).rejects.toThrow("Missing token signing secrets");
		});

		it("should throw error when refresh secret is missing", async () => {
			const { getContext } = createTestContext({
				JWT_ACCESS_SECRET: TEST_ACCESS_SECRET,
				JWT_REFRESH_SECRET: "",
			});
			const ctx = await getContext();

			await expect(
				tokenService.generateTokens(ctx, 1, "session"),
			).rejects.toThrow("Missing token signing secrets");
		});
	});

	describe("refreshAccessToken", () => {
		it("should generate new access token from refresh payload", async () => {
			const { getContext } = createTestContext();
			const ctx = await getContext();

			const refreshPayload: TokenPayload = {
				uid: 123,
				sid: "session-id",
				typ: "refresh",
				exp: Math.floor(Date.now() / 1000) + 3600,
			};

			const newAccessToken = await tokenService.refreshAccessToken(
				ctx,
				refreshPayload,
			);

			expect(newAccessToken).toBeDefined();
			expect(typeof newAccessToken).toBe("string");
		});

		it("should preserve user and session IDs in new token", async () => {
			const { getContext } = createTestContext();
			const ctx = await getContext();

			const refreshPayload: TokenPayload = {
				uid: 999,
				sid: "preserved-session",
				typ: "refresh",
				exp: Math.floor(Date.now() / 1000) + 3600,
			};

			const newAccessToken = await tokenService.refreshAccessToken(
				ctx,
				refreshPayload,
			);

			const newPayload = (await verify(
				newAccessToken,
				TEST_ACCESS_SECRET,
			)) as TokenPayload;

			expect(newPayload.uid).toBe(refreshPayload.uid);
			expect(newPayload.sid).toBe(refreshPayload.sid);
			expect(newPayload.typ).toBe("access");
		});

		it("should set new expiration time", async () => {
			const { getContext } = createTestContext();
			const ctx = await getContext();

			const now = Math.floor(Date.now() / 1000);
			const refreshPayload: TokenPayload = {
				uid: 1,
				sid: "session",
				typ: "refresh",
				exp: now + 3600,
			};

			const newAccessToken = await tokenService.refreshAccessToken(
				ctx,
				refreshPayload,
			);

			const newPayload = (await verify(
				newAccessToken,
				TEST_ACCESS_SECRET,
			)) as TokenPayload;

			// New access token should have fresh expiration
			expect(newPayload.exp).toBeGreaterThan(now);
			expect(newPayload.exp).toBeLessThanOrEqual(now + 900 + 5);
		});

		it("should throw error when access secret is missing", async () => {
			const { getContext } = createTestContext({
				JWT_ACCESS_SECRET: "",
			});
			const ctx = await getContext();

			const refreshPayload: TokenPayload = {
				uid: 1,
				sid: "session",
				typ: "refresh",
				exp: Math.floor(Date.now() / 1000) + 3600,
			};

			await expect(
				tokenService.refreshAccessToken(ctx, refreshPayload),
			).rejects.toThrow("Missing access token signing secret");
		});
	});

	describe("custom token expiry configuration", () => {
		it("should respect custom access token expiry", async () => {
			const customService = createTokenService({
				accessTokenExpiry: 60, // 1 minute
			});

			const { getContext } = createTestContext();
			const ctx = await getContext();
			const now = Math.floor(Date.now() / 1000);

			const { accessToken } = await customService.generateTokens(
				ctx,
				1,
				"session",
			);

			const payload = (await verify(
				accessToken,
				TEST_ACCESS_SECRET,
			)) as TokenPayload;

			expect(payload.exp).toBeLessThanOrEqual(now + 60 + 5);
		});

		it("should respect custom refresh token expiry", async () => {
			const customService = createTokenService({
				refreshTokenExpiry: 3600, // 1 hour
			});

			const { getContext } = createTestContext();
			const ctx = await getContext();
			const now = Math.floor(Date.now() / 1000);

			const { refreshToken } = await customService.generateTokens(
				ctx,
				1,
				"session",
			);

			const payload = (await verify(
				refreshToken,
				TEST_REFRESH_SECRET,
			)) as TokenPayload;

			expect(payload.exp).toBeLessThanOrEqual(now + 3600 + 5);
		});
	});
});
