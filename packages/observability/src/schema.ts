/**
 * @file schema.ts
 * One-time schema initialization for observability tables.
 * Runs CREATE TABLE IF NOT EXISTS once per isolate lifetime.
 * Plugin-only – removable by deleting packages/observability.
 *
 * @license Apache-2.0
 */

import { createDbClient } from "@private-landing/infrastructure";
import type { Env } from "@private-landing/types";

let initialized = false;

/**
 * Ensures all observability tables exist. Runs CREATE TABLE IF NOT EXISTS
 * on first call; subsequent calls are no-ops. Catches and logs errors
 * without crashing — leaves the flag unset so next call retries.
 */
export async function ensureSchema(env: Env): Promise<void> {
	if (initialized) return;

	try {
		const db = createDbClient(env);
		await db.execute({
			sql: `CREATE TABLE IF NOT EXISTS security_event (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				type TEXT NOT NULL,
				ip_address TEXT NOT NULL,
				user_id INTEGER,
				user_agent TEXT,
				status INTEGER,
				detail TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				actor_id TEXT NOT NULL DEFAULT 'app:private-landing'
			)`,
			args: [],
		});
		await db.execute({
			sql: `CREATE TABLE IF NOT EXISTS agent_credential (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT NOT NULL UNIQUE,
				key_hash TEXT NOT NULL,
				trust_level TEXT NOT NULL DEFAULT 'read' CHECK (trust_level IN ('read', 'write')),
				description TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				revoked_at TEXT
			)`,
			args: [],
		});
		initialized = true;
	} catch (err) {
		console.error("[obs] schema initialization failed:", err);
	}
}

/** Reset the initialization flag. Exported for testing only. @internal */
export function _resetSchemaInit(): void {
	initialized = false;
}
