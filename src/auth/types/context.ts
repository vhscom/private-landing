import type { CfProperties, KVNamespace } from "@cloudflare/workers-types";
import type { Context } from "hono";
import type { TokenPayload } from "../config/token-config";

export interface Variables {
	jwtPayload: TokenPayload;
}

export interface Bindings {
	AUTH_KV: KVNamespace;
	JWT_ACCESS_SECRET: string;
	JWT_REFRESH_SECRET: string;
	[key: string]: unknown;
}

export interface AuthContext
	extends Context<
		{
			Bindings: Bindings;
			Variables: Variables;
		},
		string
	> {}

export interface RateLimitContext
	extends Context<
		{
			Bindings: Bindings;
			Variables: Variables;
		},
		string
	> {
	// Extend Cloudflare properties available to limiter
	cf?: CfProperties;
}
