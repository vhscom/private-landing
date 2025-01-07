import type { CookieOptions } from "hono/utils/cookie";

/**
 * Session information stored in database.
 * @property id - UUID v4 session identifier
 * @property userId - Associated user ID
 * @property userAgent - Browser user agent string
 * @property ipAddress - Client IP address
 * @property expiresAt - Session expiration timestamp
 * @property createdAt - Session creation timestamp
 */
export interface SessionData {
	id: string;
	userId: number;
	userAgent: string;
	ipAddress: string;
	expiresAt: Date;
	createdAt: Date;
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
 * - 5 max sessions per user
 * - 7 day session duration
 * - 30 day maintenance window
 * - Secure cookie settings with HTTP-only and strict same-site policy
 */
export const defaultSessionConfig: SessionConfig = {
	maxSessions: 5,
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
 * @param overrides - Partial configuration to override defaults
 * @returns Complete session configuration
 */
export function createSessionConfig(
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
