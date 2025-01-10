import type { Fetcher } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { verify } from "hono/jwt";
import { handleLogin, handleRegistration } from "./accounts/handler";
import { getSession } from "./accounts/session";
import { type TokenPayload, tokenService } from "./accounts/token";
import { createDbClient } from "./db";

// Extend variables to include JWT payload
type Variables = {
	jwtPayload: TokenPayload;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

type ServeStaticOptions = {
	cache: string;
};

// Middleware that serves static content
function serveStatic(opts: ServeStaticOptions) {
	return createMiddleware<{ Bindings: Env }>(async (ctx, next) => {
		const binding = ctx.env.ASSETS as Fetcher;
		const response = await binding.fetch(
			ctx.req.url,
			/**
			 * Clone raw request and coerce to Cloudflare RequestInit type.
			 * @example
			 * import type {
			 *    RequestInit as CfRequestInit,
			 *    CfProperties,
			 * } from "@cloudflare/workers-types";
			 * ctx.req.raw.clone() as unknown as CfRequestInit<CfProperties>,
			 */
		);

		if (!response.ok) return await next();
		return response as unknown as globalThis.Response;
	});
}

// Authentication middleware that verifies access tokens
const requireAuth = createMiddleware<{ Bindings: Env; Variables: Variables }>(
	async (ctx, next) => {
		try {
			// Check for access token
			const accessToken = getCookie(ctx, "access_token");
			if (!accessToken) {
				return ctx.json({ error: "No access token provided" }, 401);
			}

			// Verify access token
			try {
				const payload = (await verify(
					accessToken,
					ctx.env.JWT_ACCESS_SECRET,
				)) as TokenPayload;

				if (payload.typ !== "access") {
					return ctx.json({ error: "Invalid token type" }, 401);
				}

				// Set payload in context before session check
				ctx.set("jwtPayload", payload);

				// Verify session still exists and is valid
				const session = await getSession(ctx);
				if (!session || session.id !== payload.sid) {
					return ctx.json({ error: "Invalid session" }, 401);
				}

				return await next();
			} catch (error) {
				// Try to refresh the access token
				const refreshToken = getCookie(ctx, "refresh_token");
				if (!refreshToken) {
					return ctx.json(
						{ error: "Access token expired and no refresh token present" },
						401,
					);
				}

				try {
					// Verify refresh token
					const refreshPayload = (await verify(
						refreshToken,
						ctx.env.JWT_REFRESH_SECRET,
					)) as TokenPayload;

					if (refreshPayload.typ !== "refresh") {
						return ctx.json({ error: "Invalid refresh token type" }, 401);
					}

					// Set refresh payload in context before session check
					ctx.set("jwtPayload", refreshPayload);

					// Verify session still exists and is valid
					const session = await getSession(ctx);
					if (!session || session.id !== refreshPayload.sid) {
						return ctx.json({ error: "Invalid session" }, 401);
					}

					// Generate new access token
					const newAccessToken = await tokenService.refreshAccessToken(
						ctx,
						refreshPayload,
					);

					// Update context with new access token payload
					const newPayload = await verify(
						newAccessToken,
						ctx.env.JWT_ACCESS_SECRET,
					);
					ctx.set("jwtPayload", newPayload);

					return await next();
				} catch {
					return ctx.json({ error: "Invalid or expired refresh token" }, 401);
				}
			}
		} catch (error) {
			console.error("Auth middleware error:", error);
			return ctx.json({ error: "Authentication failed" }, 401);
		}
	},
);

// Public routes (no authentication required)
app.use("*", serveStatic({ cache: "key" }));
app.post("/api/register", handleRegistration);
app.post("/api/login", async (ctx) => {
	const result = await handleLogin(ctx);
	if (
		result.status === 302 &&
		result.headers.get("Location")?.includes("authenticated=true")
	) {
		// Login successful, generate tokens
		const session = await getSession(ctx);
		if (session?.user_id) {
			await tokenService.generateTokens(ctx, session.user_id, session.id);
		}
	}
	return result;
});

// Protected routes (require authentication)
app.use("/api/*", requireAuth);

app.get("/api/ping", async (ctx) => {
	const payload = ctx.get("jwtPayload");
	const dbClient = createDbClient(ctx.env);
	const result = await dbClient.execute("SELECT sqlite_version();");

	return ctx.json({
		message: "Authenticated ping success!",
		userId: payload.user_id,
		version: result,
	});
});

export default app;
