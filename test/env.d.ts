declare module "cloudflare:test" {
	export * from "@cloudflare/workers-types/experimental";
	export * from "@cloudflare/vitest-pool-workers";
	export interface ProvidedEnv extends Env {}
}
