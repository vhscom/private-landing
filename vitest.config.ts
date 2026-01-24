import { defineConfig } from "vitest/config";

/**
 * Root vitest config for package unit tests.
 * Integration tests in apps/cloudflare-workers use their own Worker pool config.
 */
export default defineConfig({
	test: {
		include: ["packages/*/test/**/*.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "text-summary", "html", "json"],
			reportsDirectory: "./coverage",
			include: ["packages/*/src/**/*.ts"],
			exclude: ["packages/*/src/**/index.ts", "packages/types/**", "**/*.d.ts"],
		},
	},
});
