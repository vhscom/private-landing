import {
	defineWorkersConfig,
	type WorkersUserConfigExport,
} from "@cloudflare/vitest-pool-workers/config";

/**
 * Isolated config for plugin integration tests.
 * Runs separately from the main suite to avoid shared database state.
 */
export default defineWorkersConfig({
	test: {
		globalSetup: ["./test/setup.ts"],
		include: ["test/integration/plugins/**/*.test.ts"],
		silent: "passed-only",
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.toml" },
			},
		},
	},
} satisfies WorkersUserConfigExport);
