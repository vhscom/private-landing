import { reactRouter } from "@react-router/dev/vite";
import { cloudflareDevProxy } from "@react-router/dev/vite/cloudflare";
import { defineConfig, mergeConfig, type UserConfigExport } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { getLoadContext } from "./load-context";

const baseConfig = {
	plugins: [
		cloudflareDevProxy({ getLoadContext }),
		reactRouter(),
		tsconfigPaths(),
	],
} satisfies UserConfigExport;

export default defineConfig(() => {
	return mergeConfig(baseConfig, {
		/**
		 * Custom configuration to merge into base config.
		 * @example
		 * plugins: [reactRouter(), tsconfigPaths()]
		 **/
		ssr: {
			resolve: {
				conditions: ["workerd", "worker", "browser"],
			},
		},
		resolve: {
			mainFields: ["browser", "module", "main"],
		},
		build: {
			minify: true,
		},
	} satisfies UserConfigExport);
});
