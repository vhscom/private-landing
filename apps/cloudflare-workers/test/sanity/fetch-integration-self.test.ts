import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("dispatches fetch event", async () => {
	// `SELF` here points to the worker running in the current isolate.
	// This gets its handler from the `main` option in `vitest.config.ts`.
	const response = await SELF.fetch("https://example.com/index.html");
	expect(response.status).toBe(200);
	expect(await response.text()).toContain("<!doctype html>");
});
