/**
 * @file load-context.ts
 * Defines the load context for the React Router app, providing access to Cloudflare environment.
 *
 * @license Apache-2.0
 */

import type { PlatformProxy } from "wrangler";

type GetLoadContextArgs = {
	request: Request;
	context: {
		cloudflare: Omit<PlatformProxy<Env>, "dispose" | "caches" | "cf"> & {
			caches: PlatformProxy<Env>["caches"] | CacheStorage;
			cf: Request["cf"];
		};
	};
};

declare module "@remix-run/cloudflare" {
	// biome-ignore lint/suspicious/noEmptyInterface: Required for type extension
	interface AppLoadContext extends ReturnType<typeof getLoadContext> {
		// This will merge the result of `getLoadContext` into the `AppLoadContext`
	}
}

/**
 * Creates the load context for Remix from the Cloudflare environment.
 * Makes Cloudflare-specific functionality available to routes.
 *
 * @param args - Object containing request and context
 * @returns The Cloudflare context to be passed to routes
 */
export function getLoadContext({ context }: GetLoadContextArgs) {
	return context;
}
