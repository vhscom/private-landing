/**
 * @file app.ts
 * Main application setup with route definitions and middleware configuration.
 *
 * @license Apache-2.0
 */

import {
	createAuthSystem,
	createRateLimiter,
	createRequireAuth,
	type RateLimitConfig,
	securityHeaders,
} from "@private-landing/core";
import {
	type CacheClientFactory,
	serveStatic,
} from "@private-landing/infrastructure";
import {
	type Env,
	ValidationError,
	type Variables,
} from "@private-landing/types";
import { type Context, Hono } from "hono";
import { parseRequestBody, wantsJson } from "./utils/negotiate";

// Toggle cache: set to createValkeyClient to enable (ADR-003)
const createCacheClient: CacheClientFactory | null = null;

const auth = createAuthSystem({
	createCacheClient: createCacheClient ?? undefined,
});

// Create middleware with injected dependencies
const requireAuth = createRequireAuth({
	sessionService: auth.sessions,
	tokenService: auth.tokens,
});

const rateLimit = createRateLimiter(
	createCacheClient != null ? { createCacheClient } : null,
);

// Key extractor for authenticated routes — uses user ID from JWT payload
const userKey = (ctx: Context<{ Bindings: Env; Variables: Variables }>) =>
	String(ctx.get("jwtPayload").uid);

// Rate limit configurations — all limits visible in one place
const rateLimits = {
	auth: { windowSeconds: 300, max: 20, prefix: "rl:auth" },
	login: { windowSeconds: 300, max: 5, prefix: "rl:login" },
	register: { windowSeconds: 300, max: 5, prefix: "rl:register" },
	logout: { windowSeconds: 300, max: 5, prefix: "rl:logout", key: userKey },
	password: {
		windowSeconds: 3600,
		max: 3,
		prefix: "rl:password",
		key: userKey,
	},
} satisfies Record<string, RateLimitConfig>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Global middleware
app.use("*", securityHeaders);
app.use("*", serveStatic({ cache: "key" }));

// Health probe (public)
app.get("/health", (ctx) => {
	return ctx.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Auth lifecycle (protected — registered before group limiter to avoid IP-based blocking)
app.post(
	"/auth/logout",
	requireAuth,
	rateLimit(rateLimits.logout),
	async (ctx) => {
		const json = wantsJson(ctx);
		try {
			await auth.sessions.endSession(ctx);
			if (json) {
				return ctx.json({ success: true, message: "Logged out" }, 200);
			}
			return ctx.redirect("/#logged-out");
		} catch (error) {
			console.error("Logout error:", error);
			if (json) {
				return ctx.json(
					{ error: "Logout failed", code: "INTERNAL_ERROR" },
					500,
				);
			}
			return ctx.redirect("/#error");
		}
	},
);

// Auth lifecycle (public)
app.use("/auth/*", rateLimit(rateLimits.auth));

app.post("/auth/register", rateLimit(rateLimits.register), async (ctx) => {
	const json = wantsJson(ctx);
	try {
		const body = await parseRequestBody(ctx);
		await auth.accounts.createAccount(
			body as { email: string; password: string },
			ctx.env,
		);
		if (json) {
			return ctx.json({ success: true, message: "Account created" }, 201);
		}
		return ctx.redirect("/#registered");
	} catch (error: unknown) {
		console.error("Registration error:", error);
		if (json) {
			if (error instanceof ValidationError) {
				return ctx.json({ error: error.message, code: error.code }, 400);
			}
			return ctx.json(
				{ error: "Registration failed", code: "REGISTRATION_ERROR" },
				400,
			);
		}
		return ctx.redirect("/#error");
	}
});

app.post("/auth/login", rateLimit(rateLimits.login), async (ctx) => {
	const json = wantsJson(ctx);
	try {
		const body = await parseRequestBody(ctx);
		const authResult = await auth.accounts.authenticate(
			body as { email: string; password: string },
			ctx.env,
		);

		if (!authResult.authenticated) {
			if (json) {
				return ctx.json(
					{ error: "Authentication failed", code: "INVALID_CREDENTIALS" },
					401,
				);
			}
			return ctx.redirect("/#error");
		}

		const sessionId = await auth.sessions.createSession(authResult.userId, ctx);
		await auth.tokens.generateTokens(ctx, authResult.userId, sessionId);

		if (json) {
			return ctx.json({ success: true, message: "Login successful" }, 200);
		}
		return ctx.redirect("/#logged-in");
	} catch (error) {
		console.error("Authentication error:", error);
		if (json) {
			return ctx.json(
				{ error: "Authentication failed", code: "INTERNAL_ERROR" },
				500,
			);
		}
		return ctx.redirect("/#error");
	}
});

// Account management (protected, user-based rate limiting)
app.post(
	"/account/password",
	requireAuth,
	rateLimit(rateLimits.password),
	async (ctx) => {
		const json = wantsJson(ctx);
		try {
			const body = await parseRequestBody(ctx);
			const payload = ctx.get("jwtPayload");
			const userId = payload.uid;

			await auth.accounts.changePassword(
				body as { currentPassword: string; newPassword: string },
				userId,
				ctx.env,
			);
			await auth.sessions.endAllSessionsForUser(userId, ctx);

			if (json) {
				return ctx.json(
					{ success: true, message: "Password changed successfully" },
					200,
				);
			}
			return ctx.redirect("/#password-changed");
		} catch (error) {
			console.error("Password change error:", error);
			if (json) {
				if (error instanceof ValidationError) {
					return ctx.json({ error: error.message, code: error.code }, 400);
				}
				return ctx.json(
					{ error: "Password change failed", code: "PASSWORD_CHANGE_ERROR" },
					400,
				);
			}
			return ctx.redirect("/#error");
		}
	},
);

app.get("/account/me", requireAuth, (ctx) => {
	const payload = ctx.get("jwtPayload");
	return ctx.json({ userId: payload.uid });
});

export default app;
