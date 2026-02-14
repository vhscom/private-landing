/**
 * @file cached-session-service.test.ts
 * Unit tests for the cache-backed session service.
 * Uses createMemoryCacheClient() — real in-memory cache, no mocks.
 *
 * @license Apache-2.0
 */

import { createMemoryCacheClient } from "@private-landing/infrastructure";
import type {
	AuthContext,
	SessionConfig,
	TokenPayload,
} from "@private-landing/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCachedSessionService } from "../src/auth/services/cached-session-service";
import type { SessionService } from "../src/auth/services/session-service";

/** Shared in-memory cache instance across a single test. */
let memoryCache: ReturnType<typeof createMemoryCacheClient>;

/** Factory that always returns the shared instance. */
function cacheFactory() {
	return memoryCache;
}

/** Stub getClientIp that returns a fixed address. */
function stubGetClientIp() {
	return "127.0.0.1";
}

function createMockAuthContext(
	options: { sessionId?: string; userAgent?: string } = {},
): AuthContext {
	const { sessionId, userAgent = "Test-Agent/1.0" } = options;

	const jwtPayload: TokenPayload | undefined = sessionId
		? { uid: 1, sid: sessionId, typ: "access", exp: Date.now() / 1000 + 3600 }
		: undefined;

	const mockHeaders = new Headers();

	return {
		env: {
			AUTH_DB_URL: "libsql://test.turso.io",
			AUTH_DB_TOKEN: "test-token",
			JWT_ACCESS_SECRET: "test-access-secret",
			JWT_REFRESH_SECRET: "test-refresh-secret",
		},
		req: {
			header: vi.fn((name: string) => {
				if (name === "user-agent") return userAgent;
				return undefined;
			}),
			raw: { headers: mockHeaders },
		},
		res: { headers: mockHeaders },
		get: vi.fn((key: string) => {
			if (key === "jwtPayload") return jwtPayload;
			return undefined;
		}),
		set: vi.fn(),
		header: vi.fn(),
	} as unknown as AuthContext;
}

const shortSessionConfig: SessionConfig = {
	maxSessions: 3,
	sessionDuration: 3600, // 1 hour
	maintenanceWindow: 30,
	cookie: {
		httpOnly: true,
		secure: true,
		sameSite: "Strict",
		path: "/",
		maxAge: 3600,
	},
};

describe("CachedSessionService", () => {
	let service: SessionService;

	beforeEach(() => {
		memoryCache = createMemoryCacheClient();
		service = createCachedSessionService({
			createCacheClient: cacheFactory,
			getClientIp: stubGetClientIp,
		});
	});

	describe("createSession", () => {
		it("should create a session with a 21-char nanoid", async () => {
			const ctx = createMockAuthContext();
			const sessionId = await service.createSession(1, ctx, shortSessionConfig);

			expect(sessionId).toBeDefined();
			expect(sessionId.length).toBe(21);
		});

		it("should store session data retrievable from cache", async () => {
			const ctx = createMockAuthContext({ userAgent: "Chrome/120" });
			const sessionId = await service.createSession(
				42,
				ctx,
				shortSessionConfig,
			);

			const raw = await memoryCache.get(`session:${sessionId}`);
			expect(raw).not.toBeNull();

			const state = JSON.parse(raw as string);
			expect(state.userId).toBe(42);
			expect(state.userAgent).toBe("Chrome/120");
			expect(state.ipAddress).toBe("127.0.0.1");
		});

		it("should track session ID in user_sessions set", async () => {
			const ctx = createMockAuthContext();
			const sessionId = await service.createSession(1, ctx, shortSessionConfig);

			const members = await memoryCache.smembers("user_sessions:1");
			expect(members).toContain(sessionId);
		});

		it("should enforce session limit", async () => {
			vi.useFakeTimers();
			try {
				const freshCache = createMemoryCacheClient();
				memoryCache = freshCache;
				const svc = createCachedSessionService({
					createCacheClient: () => freshCache,
					getClientIp: stubGetClientIp,
				});

				const limitConfig: SessionConfig = {
					...shortSessionConfig,
					maxSessions: 2,
				};

				const ctx = createMockAuthContext();
				const id1 = await svc.createSession(1, ctx, limitConfig);
				vi.advanceTimersByTime(1000);
				const id2 = await svc.createSession(1, ctx, limitConfig);
				vi.advanceTimersByTime(1000);
				const id3 = await svc.createSession(1, ctx, limitConfig);

				const members = await freshCache.smembers("user_sessions:1");
				expect(members.length).toBe(2);

				// Oldest session should be evicted
				expect(members).not.toContain(id1);
				expect(members).toContain(id2);
				expect(members).toContain(id3);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("getSession", () => {
		it("should return null when no session ID in JWT payload", async () => {
			const ctx = createMockAuthContext(); // no sessionId
			const session = await service.getSession(ctx, shortSessionConfig);
			expect(session).toBeNull();
		});

		it("should return session data for a valid session", async () => {
			const ctx = createMockAuthContext();
			const sessionId = await service.createSession(1, ctx, shortSessionConfig);

			const getCtx = createMockAuthContext({ sessionId });
			const session = await service.getSession(getCtx, shortSessionConfig);

			expect(session).not.toBeNull();
			expect(session?.id).toBe(sessionId);
			expect(session?.userId).toBe(1);
		});

		it("should return null for missing/expired session", async () => {
			const ctx = createMockAuthContext({ sessionId: "nonexistent" });
			const session = await service.getSession(ctx, shortSessionConfig);
			expect(session).toBeNull();
		});

		it("should implement sliding expiration", async () => {
			vi.useFakeTimers();
			try {
				const freshCache = createMemoryCacheClient();
				memoryCache = freshCache;

				const svc = createCachedSessionService({
					createCacheClient: () => freshCache,
					getClientIp: stubGetClientIp,
				});

				const createCtx = createMockAuthContext();
				const sessionId = await svc.createSession(
					1,
					createCtx,
					shortSessionConfig,
				);

				// Advance 30 minutes — session should still be alive
				vi.advanceTimersByTime(30 * 60 * 1000);
				const getCtx = createMockAuthContext({ sessionId });
				const session = await svc.getSession(getCtx, shortSessionConfig);
				expect(session).not.toBeNull();

				// Advance another 50 minutes (total 80 min from start, but only 50 since last access)
				vi.advanceTimersByTime(50 * 60 * 1000);
				const session2 = await svc.getSession(getCtx, shortSessionConfig);
				expect(session2).not.toBeNull();
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("endSession", () => {
		it("should remove session from cache and user set", async () => {
			const ctx = createMockAuthContext();
			const sessionId = await service.createSession(1, ctx, shortSessionConfig);

			const endCtx = createMockAuthContext({ sessionId });
			await service.endSession(endCtx);

			expect(await memoryCache.get(`session:${sessionId}`)).toBeNull();
			const members = await memoryCache.smembers("user_sessions:1");
			expect(members).not.toContain(sessionId);
		});

		it("should not throw when session does not exist", async () => {
			const ctx = createMockAuthContext({ sessionId: "gone" });
			await expect(service.endSession(ctx)).resolves.not.toThrow();
		});

		it("should not throw when no session ID in payload", async () => {
			const ctx = createMockAuthContext();
			await expect(service.endSession(ctx)).resolves.not.toThrow();
		});
	});

	describe("session ID generation", () => {
		it("should generate unique session IDs", async () => {
			const ctx = createMockAuthContext();
			const ids = new Set<string>();

			for (let i = 0; i < 50; i++) {
				const id = await service.createSession(1, ctx, {
					...shortSessionConfig,
					maxSessions: 100,
				});
				ids.add(id);
			}

			expect(ids.size).toBe(50);
		});

		it("should generate URL-safe session IDs", async () => {
			const ctx = createMockAuthContext();
			const sessionId = await service.createSession(1, ctx, shortSessionConfig);
			expect(sessionId).toMatch(/^[A-Za-z0-9_-]+$/);
		});
	});
});
