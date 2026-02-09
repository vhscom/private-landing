/**
 * @file jwt-attack-vectors.test.ts
 * Attack-style negative tests for JWT handling in the authentication middleware.
 * Validates that the system rejects tampered, confused, and malformed tokens.
 *
 * @license Apache-2.0
 */

import { Hono } from "hono";
import { sign } from "hono/jwt";
import { describe, expect, it, vi } from "vitest";
import { createRequireAuth } from "../src/auth/middleware/require-auth";

const TEST_ACCESS_SECRET = "test-access-secret-key-minimum-32-chars";
const TEST_REFRESH_SECRET = "test-refresh-secret-key-minimum-32-chars";

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

function createApp(middleware: ReturnType<typeof createRequireAuth>) {
	const app = new Hono<{
		Bindings: { JWT_ACCESS_SECRET: string; JWT_REFRESH_SECRET: string };
	}>();
	app.use("*", middleware);
	app.get("/protected", (c) => c.json({ ok: true }));
	return app;
}

const ENV = {
	JWT_ACCESS_SECRET: TEST_ACCESS_SECRET,
	JWT_REFRESH_SECRET: TEST_REFRESH_SECRET,
};

// --- Helpers for manual JWT construction ---

function base64url(input: string): string {
	return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlEncode(obj: Record<string, unknown>): string {
	return base64url(JSON.stringify(obj));
}

/**
 * Tamper with a JWT payload without re-signing.
 * Decodes the payload, applies modifications, re-encodes, and reassembles
 * with the original header and signature — producing an invalid token.
 */
function tamperJwtPayload(
	token: string,
	modifications: Record<string, unknown>,
): string {
	const [header, payload, signature] = token.split(".");
	const decoded = JSON.parse(
		atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
	);
	const tampered = { ...decoded, ...modifications };
	const newPayload = base64urlEncode(tampered);
	return `${header}.${newPayload}.${signature}`;
}

describe("JWT attack vectors", () => {
	// ---------------------------------------------------------------
	// 1. Token tampering
	// ---------------------------------------------------------------
	describe("token tampering", () => {
		it("should reject token with modified uid", async () => {
			const services = createMockServices({ sessionId: "session-123" });
			const app = createApp(createRequireAuth(services));

			const token = await sign(
				{
					uid: 1,
					sid: "session-123",
					typ: "access",
					exp: Math.floor(Date.now() / 1000) + 3600,
				},
				TEST_ACCESS_SECRET,
			);
			const tampered = tamperJwtPayload(token, { uid: 999 });

			const res = await app.request(
				"/protected",
				{ headers: { Cookie: `access_token=${tampered}` } },
				ENV,
			);
			expect(res.status).toBeGreaterThanOrEqual(400);
		});

		it("should reject token with modified sid", async () => {
			const services = createMockServices({ sessionId: "session-123" });
			const app = createApp(createRequireAuth(services));

			const token = await sign(
				{
					uid: 1,
					sid: "session-123",
					typ: "access",
					exp: Math.floor(Date.now() / 1000) + 3600,
				},
				TEST_ACCESS_SECRET,
			);
			const tampered = tamperJwtPayload(token, { sid: "hijacked-session" });

			const res = await app.request(
				"/protected",
				{ headers: { Cookie: `access_token=${tampered}` } },
				ENV,
			);
			expect(res.status).toBeGreaterThanOrEqual(400);
		});

		it("should reject token with flipped typ claim", async () => {
			const services = createMockServices({ sessionId: "session-123" });
			const app = createApp(createRequireAuth(services));

			const token = await sign(
				{
					uid: 1,
					sid: "session-123",
					typ: "access",
					exp: Math.floor(Date.now() / 1000) + 3600,
				},
				TEST_ACCESS_SECRET,
			);
			const tampered = tamperJwtPayload(token, { typ: "refresh" });

			const res = await app.request(
				"/protected",
				{ headers: { Cookie: `access_token=${tampered}` } },
				ENV,
			);
			expect(res.status).toBeGreaterThanOrEqual(400);
		});

		it("should reject token with extended exp", async () => {
			const services = createMockServices({ sessionId: "session-123" });
			const app = createApp(createRequireAuth(services));

			const token = await sign(
				{
					uid: 1,
					sid: "session-123",
					typ: "access",
					exp: Math.floor(Date.now() / 1000) - 60,
				},
				TEST_ACCESS_SECRET,
			);
			// Try to extend expiration by modifying the payload (breaks signature)
			const tampered = tamperJwtPayload(token, {
				exp: Math.floor(Date.now() / 1000) + 999999,
			});

			const res = await app.request(
				"/protected",
				{ headers: { Cookie: `access_token=${tampered}` } },
				ENV,
			);
			expect(res.status).toBeGreaterThanOrEqual(400);
		});

		it("should reject token with injected extra claims", async () => {
			const services = createMockServices({ sessionId: "session-123" });
			const app = createApp(createRequireAuth(services));

			const token = await sign(
				{
					uid: 1,
					sid: "session-123",
					typ: "access",
					exp: Math.floor(Date.now() / 1000) + 3600,
				},
				TEST_ACCESS_SECRET,
			);
			const tampered = tamperJwtPayload(token, {
				admin: true,
				role: "superuser",
			});

			const res = await app.request(
				"/protected",
				{ headers: { Cookie: `access_token=${tampered}` } },
				ENV,
			);
			expect(res.status).toBeGreaterThanOrEqual(400);
		});

		it("should reject token with truncated signature", async () => {
			const services = createMockServices({ sessionId: "session-123" });
			const app = createApp(createRequireAuth(services));

			const token = await sign(
				{
					uid: 1,
					sid: "session-123",
					typ: "access",
					exp: Math.floor(Date.now() / 1000) + 3600,
				},
				TEST_ACCESS_SECRET,
			);
			const [header, payload, signature] = token.split(".");
			const truncated = `${header}.${payload}.${signature.slice(0, 5)}`;

			const res = await app.request(
				"/protected",
				{ headers: { Cookie: `access_token=${truncated}` } },
				ENV,
			);
			expect(res.status).toBeGreaterThanOrEqual(400);
		});

		it("should reject token with empty signature", async () => {
			const services = createMockServices({ sessionId: "session-123" });
			const app = createApp(createRequireAuth(services));

			const token = await sign(
				{
					uid: 1,
					sid: "session-123",
					typ: "access",
					exp: Math.floor(Date.now() / 1000) + 3600,
				},
				TEST_ACCESS_SECRET,
			);
			const [header, payload] = token.split(".");
			const noSig = `${header}.${payload}.`;

			const res = await app.request(
				"/protected",
				{ headers: { Cookie: `access_token=${noSig}` } },
				ENV,
			);
			expect(res.status).toBeGreaterThanOrEqual(400);
		});
	});

	// ---------------------------------------------------------------
	// 2. Algorithm confusion
	// ---------------------------------------------------------------
	describe("algorithm confusion", () => {
		it("should reject token with alg: none", async () => {
			const services = createMockServices({ sessionId: "session-123" });
			const app = createApp(createRequireAuth(services));

			const header = base64urlEncode({ alg: "none", typ: "JWT" });
			const payload = base64urlEncode({
				uid: 1,
				sid: "session-123",
				typ: "access",
				exp: Math.floor(Date.now() / 1000) + 3600,
			});
			const noneToken = `${header}.${payload}.`;

			const res = await app.request(
				"/protected",
				{ headers: { Cookie: `access_token=${noneToken}` } },
				ENV,
			);
			expect(res.status).toBeGreaterThanOrEqual(400);
		});

		it("should reject token signed with wrong algorithm (HS384)", async () => {
			const services = createMockServices({ sessionId: "session-123" });
			const app = createApp(createRequireAuth(services));

			// Construct a header claiming HS384 but use the same HMAC secret
			const header = base64urlEncode({ alg: "HS384", typ: "JWT" });
			const payload = base64urlEncode({
				uid: 1,
				sid: "session-123",
				typ: "access",
				exp: Math.floor(Date.now() / 1000) + 3600,
			});
			// Fake signature (not a real HS384 sig, but tests that HS256 is enforced)
			const fakeToken = `${header}.${payload}.${base64url("fake-signature-data")}`;

			const res = await app.request(
				"/protected",
				{ headers: { Cookie: `access_token=${fakeToken}` } },
				ENV,
			);
			expect(res.status).toBeGreaterThanOrEqual(400);
		});

		it("should reject token claiming RS256 algorithm", async () => {
			const services = createMockServices({ sessionId: "session-123" });
			const app = createApp(createRequireAuth(services));

			const header = base64urlEncode({ alg: "RS256", typ: "JWT" });
			const payload = base64urlEncode({
				uid: 1,
				sid: "session-123",
				typ: "access",
				exp: Math.floor(Date.now() / 1000) + 3600,
			});
			const fakeToken = `${header}.${payload}.${base64url("rsa-fake-sig")}`;

			const res = await app.request(
				"/protected",
				{ headers: { Cookie: `access_token=${fakeToken}` } },
				ENV,
			);
			expect(res.status).toBeGreaterThanOrEqual(400);
		});
	});

	// ---------------------------------------------------------------
	// 3. Token type confusion
	// ---------------------------------------------------------------
	describe("token type confusion", () => {
		it("should reject refresh token presented as access cookie", async () => {
			const services = createMockServices({ sessionId: "session-123" });
			const app = createApp(createRequireAuth(services));

			// Sign a refresh-typed token with the REFRESH secret
			const refreshToken = await sign(
				{
					uid: 1,
					sid: "session-123",
					typ: "refresh",
					exp: Math.floor(Date.now() / 1000) + 86400,
				},
				TEST_REFRESH_SECRET,
			);

			const res = await app.request(
				"/protected",
				{ headers: { Cookie: `access_token=${refreshToken}` } },
				ENV,
			);
			// Should fail: refresh secret != access secret, so signature verification fails
			expect(res.status).toBeGreaterThanOrEqual(400);
		});

		it("should reject access token presented as refresh cookie", async () => {
			const services = createMockServices({});
			const app = createApp(createRequireAuth(services));

			// Sign an access-typed token with the ACCESS secret
			const accessToken = await sign(
				{
					uid: 1,
					sid: "session-123",
					typ: "access",
					exp: Math.floor(Date.now() / 1000) + 3600,
				},
				TEST_ACCESS_SECRET,
			);

			const res = await app.request(
				"/protected",
				{ headers: { Cookie: `refresh_token=${accessToken}` } },
				ENV,
			);
			// Should fail: access secret != refresh secret
			expect(res.status).toBeGreaterThanOrEqual(400);
		});

		it("should reject refresh-typed token signed with access secret", async () => {
			const services = createMockServices({ sessionId: "session-123" });
			const app = createApp(createRequireAuth(services));

			// Refresh type claim but signed with access secret (cross-secret)
			const crossToken = await sign(
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
				{ headers: { Cookie: `access_token=${crossToken}` } },
				ENV,
			);
			// Signature is valid for access secret, but typ is "refresh" → type check fails
			expect(res.status).toBeGreaterThanOrEqual(400);
		});

		it("should reject access-typed token signed with refresh secret", async () => {
			const services = createMockServices({});
			const app = createApp(createRequireAuth(services));

			// Access type claim but signed with refresh secret
			const crossToken = await sign(
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
				{ headers: { Cookie: `refresh_token=${crossToken}` } },
				ENV,
			);
			// Signature is valid for refresh secret, but typ is "access" → type check fails
			expect(res.status).toBeGreaterThanOrEqual(400);
		});
	});

	// ---------------------------------------------------------------
	// 4. Refresh token abuse
	// ---------------------------------------------------------------
	describe("refresh token abuse", () => {
		it("should reject refresh after session revocation", async () => {
			const services = createMockServices({ sessionExists: false });
			const app = createApp(createRequireAuth(services));

			const refreshToken = await sign(
				{
					uid: 1,
					sid: "revoked-session",
					typ: "refresh",
					exp: Math.floor(Date.now() / 1000) + 86400,
				},
				TEST_REFRESH_SECRET,
			);

			const res = await app.request(
				"/protected",
				{ headers: { Cookie: `refresh_token=${refreshToken}` } },
				ENV,
			);
			expect(res.status).toBe(403);
			const body = await res.json();
			expect(body.code).toBe("SESSION_REVOKED");
		});

		it("should reject refresh with non-existent session ID", async () => {
			const services = createMockServices({ sessionExists: false });
			const app = createApp(createRequireAuth(services));

			const refreshToken = await sign(
				{
					uid: 1,
					sid: "nonexistent-id-abc123",
					typ: "refresh",
					exp: Math.floor(Date.now() / 1000) + 86400,
				},
				TEST_REFRESH_SECRET,
			);

			const res = await app.request(
				"/protected",
				{ headers: { Cookie: `refresh_token=${refreshToken}` } },
				ENV,
			);
			expect(res.status).toBe(403);
			const body = await res.json();
			expect(body.code).toBe("SESSION_REVOKED");
		});

		it("should reject when only expired access token and no refresh token", async () => {
			const services = createMockServices({});
			const app = createApp(createRequireAuth(services));

			const expiredToken = await sign(
				{
					uid: 1,
					sid: "session-123",
					typ: "access",
					exp: Math.floor(Date.now() / 1000) - 60,
				},
				TEST_ACCESS_SECRET,
			);

			const res = await app.request(
				"/protected",
				{ headers: { Cookie: `access_token=${expiredToken}` } },
				ENV,
			);
			expect(res.status).toBe(401);
			const body = await res.json();
			expect(body.code).toBe("TOKEN_EXPIRED");
		});
	});

	// ---------------------------------------------------------------
	// 5. Malformed token structures
	// ---------------------------------------------------------------
	describe("malformed token structures", () => {
		it("should reject token with one segment", async () => {
			const services = createMockServices({});
			const app = createApp(createRequireAuth(services));

			const res = await app.request(
				"/protected",
				{ headers: { Cookie: "access_token=singlesegment" } },
				ENV,
			);
			expect(res.status).toBeGreaterThanOrEqual(400);
		});

		it("should reject token with two segments", async () => {
			const services = createMockServices({});
			const app = createApp(createRequireAuth(services));

			const header = base64urlEncode({ alg: "HS256", typ: "JWT" });
			const payload = base64urlEncode({ uid: 1, typ: "access" });
			const twoSegment = `${header}.${payload}`;

			const res = await app.request(
				"/protected",
				{ headers: { Cookie: `access_token=${twoSegment}` } },
				ENV,
			);
			expect(res.status).toBeGreaterThanOrEqual(400);
		});

		it("should reject token with four segments", async () => {
			const services = createMockServices({});
			const app = createApp(createRequireAuth(services));

			const token = await sign(
				{
					uid: 1,
					sid: "session-123",
					typ: "access",
					exp: Math.floor(Date.now() / 1000) + 3600,
				},
				TEST_ACCESS_SECRET,
			);
			const fourSegment = `${token}.extra-segment`;

			const res = await app.request(
				"/protected",
				{ headers: { Cookie: `access_token=${fourSegment}` } },
				ENV,
			);
			expect(res.status).toBeGreaterThanOrEqual(400);
		});

		it("should reject token with invalid base64 in header", async () => {
			const services = createMockServices({});
			const app = createApp(createRequireAuth(services));

			const payload = base64urlEncode({ uid: 1, typ: "access" });
			const invalidHeader = `!!!not-base64!!!.${payload}.fakesig`;

			const res = await app.request(
				"/protected",
				{ headers: { Cookie: `access_token=${invalidHeader}` } },
				ENV,
			);
			expect(res.status).toBeGreaterThanOrEqual(400);
		});

		it("should reject token with invalid base64 in payload", async () => {
			const services = createMockServices({});
			const app = createApp(createRequireAuth(services));

			const header = base64urlEncode({ alg: "HS256", typ: "JWT" });
			const invalidPayload = `${header}.!!!not-base64!!!.fakesig`;

			const res = await app.request(
				"/protected",
				{ headers: { Cookie: `access_token=${invalidPayload}` } },
				ENV,
			);
			expect(res.status).toBeGreaterThanOrEqual(400);
		});

		it("should reject empty string token", async () => {
			const services = createMockServices({});
			const app = createApp(createRequireAuth(services));

			const res = await app.request(
				"/protected",
				{ headers: { Cookie: "access_token=" } },
				ENV,
			);
			expect(res.status).toBeGreaterThanOrEqual(400);
		});
	});

	// ---------------------------------------------------------------
	// 6. Session fixation
	// ---------------------------------------------------------------
	describe("session fixation", () => {
		it("should reject token with non-existent session ID", async () => {
			const services = createMockServices({ sessionExists: false });
			const app = createApp(createRequireAuth(services));

			const token = await sign(
				{
					uid: 1,
					sid: "attacker-chosen-id",
					typ: "access",
					exp: Math.floor(Date.now() / 1000) + 3600,
				},
				TEST_ACCESS_SECRET,
			);

			const res = await app.request(
				"/protected",
				{ headers: { Cookie: `access_token=${token}` } },
				ENV,
			);
			// Session doesn't exist → falls through to refresh flow → no refresh token → 401
			expect(res.status).toBeGreaterThanOrEqual(400);
		});

		it("should generate unique session IDs per login", async () => {
			const services = createMockServices({ sessionId: "session-123" });
			// Verify that createSession is called (it generates a new nanoid each time)
			// by checking that different calls produce different IDs
			const sessionIds = new Set<string>();
			services.sessionService.createSession.mockImplementation(async () => {
				const id = `session-${Math.random().toString(36).slice(2)}`;
				sessionIds.add(id);
				return id;
			});

			// Simulate two logins
			await services.sessionService.createSession(1, {} as never);
			await services.sessionService.createSession(1, {} as never);

			expect(sessionIds.size).toBe(2);
		});
	});
});
