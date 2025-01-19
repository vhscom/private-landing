import {
	createExecutionContext,
	env,
	waitOnExecutionContext,
} from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../../src/app";

it("dispatches fetch event", async () => {
	const request = new Request("https://example.com/api/ping");
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	expect(response.status).toBe(401);
	expect(await response.json()).toStrictEqual({
		error: "Authentication required",
	});
});
