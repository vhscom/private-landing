/**
 * @file session.ts
 * Session management types for user authentication system.
 * Defines types for session state, configuration, and management.
 *
 * @license Apache-2.0
 */

import type { CookieOptions } from "hono/utils/cookie";
import type { AuthContext } from "../http/context";

/**
 * Function that extracts the client IP address from a request context.
 * Allows runtime-specific IP extraction to be injected.
 */
export type GetClientIpFn = (ctx: AuthContext) => string;

/**
 * Session state information stored in database or cache.
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
 * @property maintenanceWindow - Age of sessions to clean up in days (SQL-backed sessions only; cache-backed sessions use TTL-based expiration)
 * @property cookie - Cookie configuration options
 */
export interface SessionConfig {
	maxSessions: number;
	sessionDuration: number;
	maintenanceWindow: number;
	cookie: CookieOptions;
}
