// Cookie helper function
import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import { tokenConfig } from "../config/token-config.ts";

export function setSecureCookie(
	ctx: Context,
	name: string,
	token: string,
	maxAge: number,
): void {
	setCookie(ctx, name, token, {
		httpOnly: true,
		secure: tokenConfig.cookieSecure,
		sameSite: tokenConfig.cookieSameSite,
		path: "/",
		maxAge,
	});
}
