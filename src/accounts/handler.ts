import type { Context } from "hono";
import { accountService } from "./services.ts";

export const handleRegistration = async (ctx: Context) => {
	const body = await ctx.req.parseBody();
	const { email, password } = body;
	await accountService.createAccount(
		email as string,
		password as string,
		ctx.env,
	);
	return ctx.redirect("/?registered=true");
};
