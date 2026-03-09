/**
 * @file types.ts
 * Shared types for the control plugin (ADR-010).
 * Plugin-only – removable with packages/control.
 *
 * @license Apache-2.0
 */

import type { Env, Variables } from "@private-landing/types";

export interface ControlBindings extends Env {
	GATEWAY_URL?: string;
	GATEWAY_TOKEN?: string;
	CONTROL_ALLOWED_IPS?: string;
}

export type ControlEnv = { Bindings: ControlBindings; Variables: Variables };

/** RFC 5765 link-local and loopback prefixes to reject in GATEWAY_URL. */
const BLOCKED_HOSTS = [
	"169.254.", // link-local IPv4
	"fe80:", // link-local IPv6
	"[fe80:", // bracketed link-local IPv6
	"metadata.google.", // GCP metadata
	"metadata.internal", // GCP alias
];

/** Validate GATEWAY_URL against SSRF targets. Returns true if safe. */
export function isSafeGatewayUrl(raw: string, env?: string): boolean {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return false;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	const host = url.hostname.toLowerCase();
	for (const prefix of BLOCKED_HOSTS) {
		if (host.startsWith(prefix)) return false;
	}
	// Block localhost/loopback in production
	if (
		env === "production" &&
		(host === "localhost" ||
			host === "127.0.0.1" ||
			host === "::1" ||
			host === "[::1]")
	) {
		return false;
	}
	return true;
}
