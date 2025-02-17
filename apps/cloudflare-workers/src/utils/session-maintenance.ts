/**
 * @file session-maintenance.ts
 * Session cleanup utilities for database maintenance and security.
 *
 * @license LGPL-3.0-or-later
 */

import { createDbClient } from "@private-landing/infrastructure";

/**
 * Result of session maintenance operation
 */
interface MaintenanceResult {
	expiredSessionsRemoved: number;
	oldSessionsRemoved: number;
	timestamp: string;
}

/**
 * Performs comprehensive session cleanup:
 * - Removes expired sessions
 * - Removes very old sessions (>30 days)
 * - Logs maintenance results
 *
 * @param env - Environment containing database connection
 * @returns Cleanup operation results
 */
export async function performSessionMaintenance(
	env: Env,
): Promise<MaintenanceResult> {
	const dbClient = createDbClient(env);

	// Remove all expired sessions
	const expiredResult = await dbClient.execute(
		`DELETE FROM session WHERE expires_at <= datetime('now')`,
	);

	// Remove very old sessions regardless of expiry
	const oldResult = await dbClient.execute(
		`DELETE FROM session WHERE created_at <= datetime('now', '-30 days')`,
	);

	return {
		expiredSessionsRemoved: expiredResult.rowsAffected,
		oldSessionsRemoved: oldResult.rowsAffected,
		timestamp: new Date().toISOString(),
	};
}
