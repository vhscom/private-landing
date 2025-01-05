import { describe, expect, test } from "bun:test";
import app from "./index.ts";

describe("Routes", () => {
	const mockEnv = {
		TURSO_URL: "libsql://test",
		TURSO_AUTH_TOKEN: "test",
	} as Env;

	// test("GET / Should return 200 response", async () => {
	// 	const res = await app.request(
	// 		"http://localhost/",
	// 		{ headers: new Headers() },
	// 		{} as Partial<Env>,
	// 	);
	// 	expect(res.status).toBe(200);
	// });

	test.skip("POST /api/register Should return 200 response", async () => {
		const res = await app.request(
			"http://localhost/",
			{ method: "POST", headers: { "Content-Type": "multipart/form-data" } },
			mockEnv,
		);
		expect(res.status).toBe(200);
	});
});
