import { describe, expect, test } from "bun:test";
import app from "./index.ts";

describe("Routes", () => {
	test("GET / Should return 200 response", async () => {
		const res = await app.request("http://localhost/");
		expect(res.status).toBe(200);
	});
});
