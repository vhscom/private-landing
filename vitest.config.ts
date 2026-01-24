import { defineConfig } from "vitest/config";

/**
 * Root vitest config for package unit tests.
 * Integration tests in apps/cloudflare-workers use their own Worker pool config.
 */
export default defineConfig({
	test: {
		include: ["packages/*/test/**/*.test.ts"],
	},
});
