import type { Context } from "hono";
import type { CookieOptions } from "hono/utils/cookie";

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
 * Configuration for session management.
 * @property maxSessions - Maximum active sessions per user
 * @property sessionDuration - Session duration in seconds
 * @property maintenanceWindow - Age of sessions to clean up in days
 * @property cookie - Cookie configuration options
 */
export interface SessionConfig {
	maxSessions: number;
	sessionDuration: number;
	maintenanceWindow: number;
	cookie: CookieOptions;
}

/**
 * Default session configuration.
 * - 3 max sessions per user
 * - 7 day session duration
 * - 30 day maintenance window
 * - Secure cookie settings with HTTP-only and strict same-site policy
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
