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

let initPromise: Promise<void> | null = null;

/**
 * Ensures all observability tables exist. Runs CREATE TABLE IF NOT EXISTS
 * on first call; concurrent callers share the same promise.
 * Catches and logs errors — resets the promise so the next call retries.
 */
export function ensureSchema(env: Env): Promise<void> {
	if (!initPromise) {
		initPromise = doInit(env);
	}
	return initPromise;
}

async function doInit(env: Env): Promise<void> {
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
		// Indices matching 002_observability.sql migration
		for (const idx of [
			"CREATE INDEX IF NOT EXISTS idx_security_event_type ON security_event(type)",
			"CREATE INDEX IF NOT EXISTS idx_security_event_created ON security_event(created_at)",
			"CREATE INDEX IF NOT EXISTS idx_security_event_user ON security_event(user_id)",
			"CREATE INDEX IF NOT EXISTS idx_security_event_ip ON security_event(ip_address)",
		]) {
			await db.execute({ sql: idx, args: [] });
		}
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
		await db.execute({
			sql: "CREATE INDEX IF NOT EXISTS idx_agent_credential_name ON agent_credential(name) WHERE revoked_at IS NULL",
			args: [],
		});
	} catch (err) {
		// Reset so next call retries
		initPromise = null;
		console.error("[obs] schema initialization failed:", err);
	}
}

/** Reset the initialization state. Exported for testing only. @internal */
export function _resetSchemaInit(): void {
	initPromise = null;
}
