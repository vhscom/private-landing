/**
 * @file mirrored-session-service.test.ts
 * Unit tests for the mirrored session decorator (ADR-007).
 *
 * @license Apache-2.0
 */

import {
	createMemoryCacheClient,
	type SqliteClient,
} from "@private-landing/infrastructure";
import type {
	AuthContext,
	SessionConfig,
	TokenPayload,
} from "@private-landing/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCachedSessionService } from "../src/auth/services/cached-session-service";
import { createMirroredSessionService } from "../src/auth/services/mirrored-session-service";
import type { SessionService } from "../src/auth/services/session-service";

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

const sessionConfig: SessionConfig = {
	maxSessions: 3,
	sessionDuration: 3600,
	maintenanceWindow: 30,
	cookie: {
		httpOnly: true,
		secure: true,
		sameSite: "Strict",
		path: "/",
		maxAge: 3600,
	},
};

describe("MirroredSessionService", () => {
	let mockExecute: ReturnType<typeof vi.fn>;
	let service: SessionService;

	beforeEach(() => {
		const memoryCache = createMemoryCacheClient();
		mockExecute = vi.fn().mockResolvedValue({ rows: [], rowsAffected: 0 });

		const inner = createCachedSessionService({
			createCacheClient: () => memoryCache,
			getClientIp: stubGetClientIp,
		});

		service = createMirroredSessionService({
			inner,
			createDbClient: () => ({ execute: mockExecute }) as SqliteClient,
		});
	});

	it("should INSERT into SQL on createSession", async () => {
		const ctx = createMockAuthContext();
		const sessionId = await service.createSession(1, ctx, sessionConfig);

		expect(sessionId).toBeDefined();
		expect(mockExecute).toHaveBeenCalledWith(
			expect.objectContaining({
				sql: expect.stringContaining("INSERT INTO session"),
				args: expect.arrayContaining([sessionId, 1]),
			}),
		);
	});

	it("should enforce session limit in SQL after INSERT", async () => {
		const ctx = createMockAuthContext();
		await service.createSession(1, ctx, sessionConfig);

		expect(mockExecute).toHaveBeenCalledWith(
			expect.objectContaining({
				sql: expect.stringContaining("ROW_NUMBER()"),
				args: [1, sessionConfig.maxSessions],
			}),
		);
	});

	it("should UPDATE SQL on endSession", async () => {
		const ctx = createMockAuthContext();
		const sessionId = await service.createSession(1, ctx, sessionConfig);

		mockExecute.mockClear();
		const endCtx = createMockAuthContext({ sessionId });
		await service.endSession(endCtx);

		expect(mockExecute).toHaveBeenCalledWith(
			expect.objectContaining({
				sql: expect.stringContaining("UPDATE session SET expires_at"),
				args: [sessionId],
			}),
		);
	});

	it("should UPDATE SQL on endAllSessionsForUser", async () => {
		const ctx = createMockAuthContext();
		await service.createSession(1, ctx, sessionConfig);

		mockExecute.mockClear();
		await service.endAllSessionsForUser(1, ctx);

		expect(mockExecute).toHaveBeenCalledWith(
			expect.objectContaining({
				sql: expect.stringContaining("UPDATE session SET expires_at"),
				args: [1],
			}),
		);
	});

	it("should delegate getSession without SQL writes", async () => {
		const ctx = createMockAuthContext();
		const sessionId = await service.createSession(1, ctx, sessionConfig);

		mockExecute.mockClear();
		const getCtx = createMockAuthContext({ sessionId });
		const session = await service.getSession(getCtx, sessionConfig);

		expect(session).not.toBeNull();
		expect(session?.id).toBe(sessionId);
		expect(mockExecute).not.toHaveBeenCalled();
	});

	it("should not block auth when SQL fails", async () => {
		mockExecute.mockRejectedValue(new Error("DB unavailable"));
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const ctx = createMockAuthContext();
		const sessionId = await service.createSession(1, ctx, sessionConfig);

		expect(sessionId).toBeDefined();
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining("[mirrored-session]"),
			expect.any(Error),
		);

		consoleSpy.mockRestore();
	});

	it("uses getClientIp for IP in SQL INSERT", async () => {
		const memoryCache = createMemoryCacheClient();
		const localExecute = vi
			.fn()
			.mockResolvedValue({ rows: [], rowsAffected: 0 });

		const inner = createCachedSessionService({
			createCacheClient: () => memoryCache,
			getClientIp: stubGetClientIp,
		});

		const svc = createMirroredSessionService({
			inner,
			createDbClient: () => ({ execute: localExecute }) as SqliteClient,
			getClientIp: () => "10.0.0.1",
		});

		const ctx = createMockAuthContext();
		await svc.createSession(1, ctx, sessionConfig);

		const insertCall = localExecute.mock.calls.find(
			(c: unknown[]) =>
				typeof c[0] === "object" &&
				(c[0] as { sql: string }).sql.includes("INSERT INTO session"),
		);
		expect(insertCall).toBeDefined();
		expect((insertCall?.[0] as { args: unknown[] }).args).toContain("10.0.0.1");
	});

	it("uses 'unknown' when getClientIp throws", async () => {
		const memoryCache = createMemoryCacheClient();
		const localExecute = vi
			.fn()
			.mockResolvedValue({ rows: [], rowsAffected: 0 });

		const inner = createCachedSessionService({
			createCacheClient: () => memoryCache,
			getClientIp: stubGetClientIp,
		});

		const svc = createMirroredSessionService({
			inner,
			createDbClient: () => ({ execute: localExecute }) as SqliteClient,
			getClientIp: () => {
				throw new Error("no conn info");
			},
		});

		const ctx = createMockAuthContext();
		await svc.createSession(1, ctx, sessionConfig);

		const insertCall = localExecute.mock.calls.find(
			(c: unknown[]) =>
				typeof c[0] === "object" &&
				(c[0] as { sql: string }).sql.includes("INSERT INTO session"),
		);
		expect(insertCall).toBeDefined();
		expect((insertCall?.[0] as { args: unknown[] }).args).toContain("unknown");
	});

	it("catches and logs SQL error in endSession", async () => {
		const memoryCache = createMemoryCacheClient();
		const localExecute = vi
			.fn()
			.mockResolvedValue({ rows: [], rowsAffected: 0 });

		const inner = createCachedSessionService({
			createCacheClient: () => memoryCache,
			getClientIp: stubGetClientIp,
		});

		const svc = createMirroredSessionService({
			inner,
			createDbClient: () => ({ execute: localExecute }) as SqliteClient,
		});

		const ctx = createMockAuthContext();
		const sessionId = await svc.createSession(1, ctx, sessionConfig);

		// Make the UPDATE in endSession fail
		localExecute.mockRejectedValueOnce(new Error("SQL write failed"));
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const endCtx = createMockAuthContext({ sessionId });
		await svc.endSession(endCtx);

		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining("[mirrored-session] end failed:"),
			expect.any(Error),
		);
		consoleSpy.mockRestore();
	});

	it("catches and logs SQL error in endAllSessionsForUser", async () => {
		const memoryCache = createMemoryCacheClient();
		const localExecute = vi
			.fn()
			.mockResolvedValue({ rows: [], rowsAffected: 0 });

		const inner = createCachedSessionService({
			createCacheClient: () => memoryCache,
			getClientIp: stubGetClientIp,
		});

		const svc = createMirroredSessionService({
			inner,
			createDbClient: () => ({ execute: localExecute }) as SqliteClient,
		});

		const ctx = createMockAuthContext();
		await svc.createSession(1, ctx, sessionConfig);

		// Make the UPDATE in endAllSessionsForUser fail
		localExecute.mockRejectedValueOnce(new Error("SQL write failed"));
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await svc.endAllSessionsForUser(1, ctx);

		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining("[mirrored-session] endAll failed:"),
			expect.any(Error),
		);
		consoleSpy.mockRestore();
	});
});
