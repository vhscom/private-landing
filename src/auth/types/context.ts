import type { Context } from "hono";
import type { TokenPayload } from "../config/token-config.ts";

export interface Variables {
	jwtPayload: TokenPayload;
}

export interface AuthContext
	extends Context<
		{
			Bindings: Env;
			Variables: Variables;
		},
		string
	> {}
