/**
 * @file session.ts
 * Session management types for user authentication system.
 * Defines types for session state, configuration, and management.
 *
 * @license Apache-2.0
 */

import type { CookieOptions } from "hono/utils/cookie";

/**
 * Session state information stored in database.
 * @property id - 21 character nanoid session identifier
 * @property userId - Associated user ID
 * @property userAgent - Browser user agent string
 * @property ipAddress - Client IP address
 * @property expiresAt - Session expiration timestamp
 * @property createdAt - Session creation timestamp
 */
export interface SessionState {
	id: string;
	userId: number;
	userAgent: string;
	ipAddress: string;
	expiresAt: string;
	createdAt: string;
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
