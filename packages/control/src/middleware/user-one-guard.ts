/**
 * @file user-one-guard.ts
 * Middleware that restricts access to user account 1 (the operator).
 * Returns 404 for all other users — indistinguishable from a non-existent route.
 * Plugin-only – removable with packages/control (ADR-010).
 *
 * @license Apache-2.0
 */

import type { MiddlewareHandler } from "hono";
import type { ControlEnv } from "../types";

export const userOneGuard: MiddlewareHandler<ControlEnv> = async (
	ctx,
	next,
) => {
	const payload = ctx.get("jwtPayload");
	if (payload?.uid !== 1) {
		return ctx.notFound();
	}
	return next();
};
