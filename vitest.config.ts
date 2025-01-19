import {
	type WorkersUserConfigExport,
	defineWorkersConfig,
} from "@cloudflare/vitest-pool-workers/config";

/**
 * Define workers config for testing
 * @see https://developers.cloudflare.com/workers/testing/vitest-integration/
 * @see https://hono.dev/examples/cloudflare-vitest
 * @see https://github.com/cloudflare/workers-sdk/tree/main/fixtures/vitest-pool-workers-examples
 */
export default defineWorkersConfig({
	test: {
		globalSetup: ["./test/global-setup.ts"],
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.test.toml", environment: "test" },
			},
		},
	},
} satisfies WorkersUserConfigExport);
