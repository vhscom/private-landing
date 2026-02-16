import {
	createExecutionContext,
	env,
	waitOnExecutionContext,
} from "cloudflare:test";
import worker from "@private-landing/cloudflare-workers/src/app";
import { expect, it } from "vitest";

it("dispatches fetch event", async () => {
	const request = new Request("https://example.com/account/me");
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	expect(response.status).toBe(401);
	expect(await response.json()).toStrictEqual({
		code: "TOKEN_EXPIRED",
		error: "Token expired",
	});
});
