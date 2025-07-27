/**
 * @file session-config.ts
 * Configuration and type definitions for user session management.
 *
 * @license Apache-2.0
 */

import type { SessionConfig } from "@private-landing/types";
import type { Context } from "hono";

/**
 * Session information stored in database.
 * @property id - 21 character nanoid session identifier
 * @property user_id - Associated user ID
 * @property user_agent - Browser user agent string
 * @property ip_address - Client IP address
 * @property expires_at - Session expiration timestamp
 * @property created_at - Session creation timestamp
 */
export interface SessionData {
	id: string;
	user_id: number;
	user_agent: string;
	ip_address: string;
	expires_at: string;
	created_at: string;
}

/**
 * Default session configuration.
 * - 3 max sessions per user (balance between convenience and security)
 * - 7 day session duration (standard duration for remembered sessions)
 * - 30 day maintenance window (ensures cleanup of abandoned sessions)
 * - Secure cookie settings:
 *   - HTTP-only to prevent XSS access
 *   - Strict SameSite to prevent CSRF
 *   - Secure flag for HTTPS only
 *   - Partitioned for privacy
 */
export const defaultSessionConfig: SessionConfig = {
	maxSessions: 3,
	sessionDuration: 60 * 60 * 24 * 7, // 7 days in seconds
	maintenanceWindow: 30, // days
	cookie: {
		httpOnly: true,
		secure: true,
		sameSite: "Strict",
		path: "/",
		maxAge: 60 * 60 * 24 * 7,
		partitioned: true,
	},
};

/**
 * Creates session configuration with custom overrides.
 * @param ctx - Hono context containing request and environment
 * @param overrides - Partial configuration to override defaults
 * @returns Complete session configuration
 */
export function createSessionConfig(
	ctx: Context,
	overrides?: Partial<SessionConfig>,
): SessionConfig {
	return {
		...defaultSessionConfig,
		...overrides,
		cookie: {
			...defaultSessionConfig.cookie,
			...overrides?.cookie,
		},
	};
}
