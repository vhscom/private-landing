import type { Context } from "hono";
import { accountService } from "./services";

export async function handleLogin(ctx: Context) {
	try {
		const body = await ctx.req.parseBody();
		const { email, password } = body;

		const authenticated = await accountService.authenticate(
			email as string,
			password as string,
			ctx.env,
		);

		if (!authenticated) {
			return ctx.redirect("/?error=Invalid email or password");
		}

		return ctx.redirect("/?authenticated=true");
	} catch (error) {
		console.error("Authentication error:", error);
		return ctx.redirect("/?error=Authentication failed. Please try again.");
	}
}

export async function handleRegistration(ctx: Context) {
	try {
		const body = await ctx.req.parseBody();
		const { email, password } = body;
		await accountService.createAccount(
			email as string,
			password as string,
			ctx.env,
		);
		return ctx.redirect("/?registered=true");
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "VALIDATION_ERROR"
		) {
			// Return validation errors with 400 status
			return ctx.redirect(`/?error=${encodeURIComponent(error.message)}`);
		}
		// Log unexpected errors and return generic message
		console.error("Registration error:", error);
		return ctx.redirect("/?error=Registration failed. Please try again.");
	}
}
