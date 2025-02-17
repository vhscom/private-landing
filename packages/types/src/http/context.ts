/**
 * @file context.ts
 * HTTP context types for the Hono framework integration.
 * Extends Hono's context types with authentication-specific additions.
 *
 * @license LGPL-3.0-or-later
 */

import type { Context } from "hono";
import type { TokenPayload } from "../auth";
import type { Env } from "../env";

/**
 * Defines the structure of variables available throughout the application context.
 * These variables are accessible within request handlers and middleware.
 *
 * @interface Variables
 * @property {TokenPayload} jwtPayload - Contains the decoded JWT payload information
 */
export interface Variables {
	jwtPayload: TokenPayload;
}

/**
 * Extends Hono's base Context type to include application-specific bindings and variables.
 * This provides type safety and autocompletion for the application's context object.
 *
 * @interface AuthContext
 * @extends {Context}
 * @template Bindings - Environment bindings (defined as Env)
 * @template Variables - Application variables containing JWT payload
 * @template string - Path parameters type (using string as default)
 */
export interface AuthContext
	extends Context<
		{
			Bindings: Env;
			Variables: Variables;
		},
		string
	> {}
