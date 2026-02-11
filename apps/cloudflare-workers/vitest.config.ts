import {
	defineWorkersConfig,
	type WorkersUserConfigExport,
} from "@cloudflare/vitest-pool-workers/config";

const isCI = process.env.CI === "true";

/**
 * Define workers config for testing
 * @see https://developers.cloudflare.com/workers/testing/vitest-integration/
 * @see https://hono.dev/examples/cloudflare-vitest
 * @see https://github.com/cloudflare/workers-sdk/tree/main/fixtures/vitest-pool-workers-examples
 */
export default defineWorkersConfig({
	test: {
		...(isCI ? {} : { maxConcurrency: 1 }),
		globalSetup: ["./test/setup.ts"],
		include: [
			"src/**/*.test.ts",
			"test/integration/**/*.test.ts",
			"test/sanity/**/*.test.ts",
		],
		silent: "passed-only",
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.toml" },
			},
		},
	},
} satisfies WorkersUserConfigExport);
