/**
 * @file session-service.test.ts
 * Unit tests for session management service.
 *
 * @license Apache-2.0
 */

import type {
	AuthContext,
	SessionConfig,
	TokenPayload,
} from "@private-landing/types";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { createSessionService } from "../src/auth/services/session-service";

// Mock database client
function createMockDbClient() {
	return {
		execute: vi.fn(),
		batch: vi.fn(),
		transaction: vi.fn(),
		executeMultiple: vi.fn(),
		sync: vi.fn(),
		close: vi.fn(),
		migrate: vi.fn(),
		closed: false,
		protocol: "http" as const,
	};
}

// Mock AuthContext factory
function createMockAuthContext(
	options: { sessionId?: string; userAgent?: string; ipAddress?: string } = {},
): AuthContext {
	const {
		sessionId,
		userAgent = "Test-Agent/1.0",
		/* biome-ignore lint/correctness/noUnusedVariables: intentional */
		ipAddress = "127.0.0.1",
	} = options;

	const jwtPayload: TokenPayload | undefined = sessionId
		? { uid: 1, sid: sessionId, typ: "access", exp: Date.now() / 1000 + 3600 }
		: undefined;

	// Create mock headers for cookie operations
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
			raw: {
				headers: mockHeaders,
			},
		},
		res: {
			headers: mockHeaders,
		},
		get: vi.fn((key: string) => {
			if (key === "jwtPayload") return jwtPayload;
			return undefined;
		}),
		set: vi.fn(),
		header: vi.fn(),
		// Add minimal Hono context properties for getConnInfo
		executionCtx: {
			waitUntil: vi.fn(),
			passThroughOnException: vi.fn(),
		},
	} as unknown as AuthContext;
}

describe("SessionService", () => {
	let mockDbClient: ReturnType<typeof createMockDbClient>;
	let mockCreateDbClient: Mock;

	beforeEach(() => {
		mockDbClient = createMockDbClient();
		mockCreateDbClient = vi.fn(() => mockDbClient);
	});

	describe("createSessionService", () => {
		it("should create service with default configuration", () => {
			const service = createSessionService({
				createDbClient: mockCreateDbClient,
			});

			expect(service).toBeDefined();
			expect(service.createSession).toBeDefined();
			expect(service.getSession).toBeDefined();
			expect(service.endSession).toBeDefined();
		});

		it("should create service with custom table configuration", () => {
			const service = createSessionService({
				tableName: "custom_sessions",
				idColumn: "session_id",
				userIdColumn: "account_id",
				createDbClient: mockCreateDbClient,
			});

			expect(service).toBeDefined();
		});
	});

	describe("createSession", () => {
		it("should create a new session with generated ID", async () => {
			// Mock cleanup (no expired sessions)
			mockDbClient.execute
				.mockResolvedValueOnce({ rowsAffected: 0 }) // cleanup
				.mockResolvedValueOnce({ rowsAffected: 0 }) // enforce limit
				.mockResolvedValueOnce({ rowsAffected: 1 }); // insert

			const service = createSessionService({
				createDbClient: mockCreateDbClient,
			});
			const ctx = createMockAuthContext();

			const sessionId = await service.createSession(1, ctx);

			expect(sessionId).toBeDefined();
			expect(sessionId.length).toBe(21); // nanoid default length
		});

		it("should store session with correct user data", async () => {
			mockDbClient.execute
				.mockResolvedValueOnce({ rowsAffected: 0 })
				.mockResolvedValueOnce({ rowsAffected: 0 })
				.mockResolvedValueOnce({ rowsAffected: 1 });

			const service = createSessionService({
				createDbClient: mockCreateDbClient,
			});
			const ctx = createMockAuthContext({ userAgent: "Chrome/120.0" });

			await service.createSession(42, ctx);

			// Verify the INSERT call (3rd call)
			const insertCall = mockDbClient.execute.mock.calls[1];
			expect(insertCall[0].sql).toContain("INSERT INTO session");
			expect(insertCall[0].args[1]).toBe(42); // userId
			expect(insertCall[0].args[2]).toBe("Chrome/120.0"); // userAgent
		});

		it("should cleanup expired sessions before creating new one", async () => {
			mockDbClient.execute
				.mockResolvedValueOnce({ rowsAffected: 5 }) // cleanup removed 5
				.mockResolvedValueOnce({ rowsAffected: 0 })
				.mockResolvedValueOnce({ rowsAffected: 1 });

			const service = createSessionService({
				createDbClient: mockCreateDbClient,
			});
			const ctx = createMockAuthContext();

			await service.createSession(1, ctx);

			// First call is the cleanup DELETE - it's called with a template literal string
			const cleanupSql = mockDbClient.execute.mock.calls[0][0];
			expect(cleanupSql).toContain("DELETE FROM session");
			expect(cleanupSql).toContain("expires_at");
		});

		it("should enforce session limit for user", async () => {
			const customConfig = {
				sessionDuration: 3600,
				maxSessions: 2,
			} as SessionConfig;

			mockDbClient.execute
				.mockResolvedValueOnce({ rowsAffected: 0 })
				.mockResolvedValueOnce({ rowsAffected: 1 }) // removed 1 old session
				.mockResolvedValueOnce({ rowsAffected: 1 });

			const service = createSessionService({
				createDbClient: mockCreateDbClient,
			});
			const ctx = createMockAuthContext();

			await service.createSession(1, ctx, customConfig);

			const limitCall = mockDbClient.execute.mock.calls[2];
			expect(limitCall[0].args).toContain(1); // userId
			expect(limitCall[0].args).toContain(2); // maxSessions
		});

		it("should use custom table names in queries", async () => {
			mockDbClient.execute
				.mockResolvedValueOnce({ rowsAffected: 0 })
				.mockResolvedValueOnce({ rowsAffected: 0 })
				.mockResolvedValueOnce({ rowsAffected: 1 });

			const service = createSessionService({
				tableName: "user_sessions",
				idColumn: "session_id",
				userIdColumn: "account_id",
				createDbClient: mockCreateDbClient,
			});
			const ctx = createMockAuthContext();

			await service.createSession(1, ctx);

			const insertCall = mockDbClient.execute.mock.calls[1];
			expect(insertCall[0].sql).toContain("INSERT INTO user_sessions");
			expect(insertCall[0].sql).toContain("session_id");
			expect(insertCall[0].sql).toContain("account_id");
		});

		it("should set correct expiration time based on config", async () => {
			const customConfig = {
				sessionDuration: 7200, // 2 hours
				maxSessions: 3,
			} as SessionConfig;

			mockDbClient.execute
				.mockResolvedValueOnce({ rowsAffected: 0 })
				.mockResolvedValueOnce({ rowsAffected: 0 })
				.mockResolvedValueOnce({ rowsAffected: 1 });

			const service = createSessionService({
				createDbClient: mockCreateDbClient,
			});
			const ctx = createMockAuthContext();

			const before = Date.now();
			await service.createSession(1, ctx, customConfig);
			const after = Date.now();

			const insertCall = mockDbClient.execute.mock.calls[1];
			const expiresAt = new Date(insertCall[0].args[4]).getTime();
			const expectedMin = before + 7200 * 1000;
			const expectedMax = after + 7200 * 1000;

			expect(expiresAt).toBeGreaterThanOrEqual(expectedMin);
			expect(expiresAt).toBeLessThanOrEqual(expectedMax);
		});
	});

	describe("getSession", () => {
		it("should return null when no session ID in JWT payload", async () => {
			const service = createSessionService({
				createDbClient: mockCreateDbClient,
			});
			const ctx = createMockAuthContext(); // No sessionId

			const session = await service.getSession(ctx);

			expect(session).toBeNull();
			expect(mockDbClient.execute).not.toHaveBeenCalled();
		});

		it("should return session data when session is valid", async () => {
			const sessionData = {
				id: "test-session-id",
				user_id: 1,
				user_agent: "Test-Agent",
				ip_address: "127.0.0.1",
				expires_at: new Date(Date.now() + 3600000).toISOString(),
				created_at: new Date().toISOString(),
			};

			mockDbClient.execute
				.mockResolvedValueOnce({ rowsAffected: 1 }) // extend session
				.mockResolvedValueOnce({ rows: [sessionData] }); // select session

			const service = createSessionService({
				createDbClient: mockCreateDbClient,
			});
			const ctx = createMockAuthContext({ sessionId: "test-session-id" });

			const session = await service.getSession(ctx);

			expect(session).not.toBeNull();
			expect(session?.id).toBe("test-session-id");
		});

		it("should return null when session cannot be extended (expired)", async () => {
			mockDbClient.execute.mockResolvedValueOnce({ rowsAffected: 0 }); // extend failed

			const service = createSessionService({
				createDbClient: mockCreateDbClient,
			});
			const ctx = createMockAuthContext({ sessionId: "expired-session" });

			const session = await service.getSession(ctx);

			expect(session).toBeNull();
		});

		it("should return null when session not found in database", async () => {
			mockDbClient.execute
				.mockResolvedValueOnce({ rowsAffected: 1 }) // extend succeeded
				.mockResolvedValueOnce({ rows: [] }); // but not found (race condition)

			const service = createSessionService({
				createDbClient: mockCreateDbClient,
			});
			const ctx = createMockAuthContext({ sessionId: "missing-session" });

			const session = await service.getSession(ctx);

			expect(session).toBeNull();
		});

		it("should extend session with sliding expiration", async () => {
			const customConfig = {
				sessionDuration: 7200,
				maxSessions: 3,
			} as SessionConfig;

			mockDbClient.execute
				.mockResolvedValueOnce({ rowsAffected: 1 })
				.mockResolvedValueOnce({ rows: [{ id: "test-session" }] });

			const service = createSessionService({
				createDbClient: mockCreateDbClient,
			});
			const ctx = createMockAuthContext({ sessionId: "test-session" });

			await service.getSession(ctx, customConfig);

			const extendCall = mockDbClient.execute.mock.calls[0];
			expect(extendCall[0].args[0]).toBe(7200); // duration in seconds
			expect(extendCall[0].args[1]).toBe("test-session");
		});
	});

	describe("endSession", () => {
		it("should expire session immediately", async () => {
			mockDbClient.execute.mockResolvedValueOnce({ rowsAffected: 1 });

			const service = createSessionService({
				createDbClient: mockCreateDbClient,
			});
			const ctx = createMockAuthContext({ sessionId: "session-to-end" });

			await service.endSession(ctx);

			const updateCall = mockDbClient.execute.mock.calls[0];
			expect(updateCall[0].sql).toContain("UPDATE session");
			expect(updateCall[0].sql).toContain("expires_at = datetime('now')");
			expect(updateCall[0].args).toContain("session-to-end");
		});

		it("should not execute query when no session ID present", async () => {
			const service = createSessionService({
				createDbClient: mockCreateDbClient,
			});
			// Create context without sessionId but with a payload that has undefined sid
			const ctx = {
				...createMockAuthContext(),
				get: vi.fn((key: string) => {
					if (key === "jwtPayload")
						return { uid: 1, typ: "access", exp: Date.now() / 1000 + 3600 };
					return undefined;
				}),
			} as unknown as AuthContext;

			await service.endSession(ctx);

			expect(mockDbClient.execute).not.toHaveBeenCalled();
		});

		it("should use custom table name when configured", async () => {
			mockDbClient.execute.mockResolvedValueOnce({ rowsAffected: 1 });

			const service = createSessionService({
				tableName: "custom_sessions",
				idColumn: "session_id",
				createDbClient: mockCreateDbClient,
			});
			const ctx = createMockAuthContext({ sessionId: "test-session" });

			await service.endSession(ctx);

			const updateCall = mockDbClient.execute.mock.calls[0];
			expect(updateCall[0].sql).toContain("UPDATE custom_sessions");
			expect(updateCall[0].sql).toContain("session_id = ?");
		});
	});

	describe("dependency injection", () => {
		it("should use injected database client factory", async () => {
			const customFactory = vi.fn(() => mockDbClient);

			mockDbClient.execute
				.mockResolvedValueOnce({ rowsAffected: 0 })
				.mockResolvedValueOnce({ rowsAffected: 0 })
				.mockResolvedValueOnce({ rowsAffected: 1 });

			const service = createSessionService({ createDbClient: customFactory });
			const ctx = createMockAuthContext();

			await service.createSession(1, ctx);

			expect(customFactory).toHaveBeenCalledWith(ctx.env);
		});

		it("should pass environment to database client factory", async () => {
			const customEnv = {
				AUTH_DB_URL: "libsql://custom.turso.io",
				AUTH_DB_TOKEN: "custom-token",
				JWT_ACCESS_SECRET: "custom-access",
				JWT_REFRESH_SECRET: "custom-refresh",
			};

			const ctx = {
				...createMockAuthContext(),
				env: customEnv,
			} as unknown as AuthContext;

			mockDbClient.execute
				.mockResolvedValueOnce({ rowsAffected: 0 })
				.mockResolvedValueOnce({ rowsAffected: 0 })
				.mockResolvedValueOnce({ rowsAffected: 1 });

			const service = createSessionService({
				createDbClient: mockCreateDbClient,
			});
			await service.createSession(1, ctx);

			expect(mockCreateDbClient).toHaveBeenCalledWith(customEnv);
		});
	});

	describe("endAllSessionsForUser", () => {
		it("should expire all active sessions for a user", async () => {
			mockDbClient.execute.mockResolvedValueOnce({ rowsAffected: 3 });

			const service = createSessionService({
				createDbClient: mockCreateDbClient,
			});
			const ctx = createMockAuthContext({ sessionId: "any-session" });

			await service.endAllSessionsForUser(42, ctx);

			const updateCall = mockDbClient.execute.mock.calls[0];
			expect(updateCall[0].sql).toContain("UPDATE session");
			expect(updateCall[0].sql).toContain("expires_at = datetime('now')");
			expect(updateCall[0].sql).toContain("user_id = ?");
			expect(updateCall[0].sql).toContain("expires_at > datetime('now')");
			expect(updateCall[0].args).toContain(42);
		});

		it("should handle user with no active sessions", async () => {
			mockDbClient.execute.mockResolvedValueOnce({ rowsAffected: 0 });

			const service = createSessionService({
				createDbClient: mockCreateDbClient,
			});
			const ctx = createMockAuthContext({ sessionId: "any-session" });

			await expect(
				service.endAllSessionsForUser(99, ctx),
			).resolves.not.toThrow();
		});
	});

	describe("session ID generation", () => {
		it("should generate unique session IDs", async () => {
			mockDbClient.execute.mockResolvedValue({ rowsAffected: 0 });

			const service = createSessionService({
				createDbClient: mockCreateDbClient,
			});
			const ctx = createMockAuthContext();

			const ids = new Set<string>();
			for (let i = 0; i < 100; i++) {
				mockDbClient.execute.mockClear();
				mockDbClient.execute
					.mockResolvedValueOnce({ rowsAffected: 0 })
					.mockResolvedValueOnce({ rowsAffected: 0 })
					.mockResolvedValueOnce({ rowsAffected: 1 });

				const id = await service.createSession(1, ctx);
				ids.add(id);
			}

			expect(ids.size).toBe(100); // All IDs should be unique
		});

		it("should generate URL-safe session IDs", async () => {
			mockDbClient.execute
				.mockResolvedValueOnce({ rowsAffected: 0 })
				.mockResolvedValueOnce({ rowsAffected: 0 })
				.mockResolvedValueOnce({ rowsAffected: 1 });

			const service = createSessionService({
				createDbClient: mockCreateDbClient,
			});
			const ctx = createMockAuthContext();

			const sessionId = await service.createSession(1, ctx);

			// nanoid uses URL-safe alphabet
			expect(sessionId).toMatch(/^[A-Za-z0-9_-]+$/);
		});
	});
});
