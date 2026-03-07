/**
 * @file ip-allowlist.ts
 * Optional IP allowlist for control routes. Returns 404 for disallowed IPs.
 * When CONTROL_ALLOWED_IPS is unset, all IPs are permitted.
 * Plugin-only – removable with packages/control (ADR-010).
 *
 * @license Apache-2.0
 */

import type { GetClientIpFn } from "@private-landing/types";
import type { MiddlewareHandler } from "hono";
import type { ControlEnv } from "../types";

export function createIpAllowlist(
	getClientIp?: GetClientIpFn,
): MiddlewareHandler<ControlEnv> {
	return async (ctx, next) => {
		const allowedRaw = ctx.env.CONTROL_ALLOWED_IPS;
		if (!allowedRaw) {
			return next();
		}

		const allowed = allowedRaw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		if (allowed.length === 0) {
			return next();
		}

		let ip = "unknown";
		if (getClientIp) {
			try {
				ip = getClientIp(ctx as unknown as Parameters<GetClientIpFn>[0]);
			} catch {
				// Fall through — unknown IP is not in the allowlist
			}
		}

		if (!allowed.includes(ip)) {
			return ctx.notFound();
		}

		return next();
	};
}
