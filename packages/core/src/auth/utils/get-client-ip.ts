/**
 * @file get-client-ip.ts
 * Client IP extraction utility. Isolates the Cloudflare-specific
 * runtime import so the rest of core remains runtime-agnostic.
 *
 * @license Apache-2.0
 */

import type { GetClientIpFn } from "@private-landing/types";
import { getConnInfo } from "hono/cloudflare-workers";

/**
 * Default implementation that extracts the client IP using
 * Cloudflare Workers' `getConnInfo`.
 */
export const defaultGetClientIp: GetClientIpFn = (ctx) => {
	const connInfo = getConnInfo(ctx);
	return connInfo.remote?.address ?? "unknown";
};
