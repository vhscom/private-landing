import {
	defineWorkersConfig,
	type WorkersUserConfigExport,
} from "@cloudflare/vitest-pool-workers/config";

/**
 * Define workers config for testing
 * @see https://developers.cloudflare.com/workers/testing/vitest-integration/
 * @see https://hono.dev/examples/cloudflare-vitest
 * @see https://github.com/cloudflare/workers-sdk/tree/main/fixtures/vitest-pool-workers-examples
 */
export default defineWorkersConfig({
	test: {
		globalSetup: ["./test/setup.ts"],
		include: ["test/integration/**/*.test.ts", "test/sanity/**/*.test.ts"],
		silent: "passed-only",
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.toml" },
			},
		},
	},
} satisfies WorkersUserConfigExport);
