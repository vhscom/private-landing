/**
 * @file client.ts
 * Database client factory with environment-based configuration.
 *
 * @license Apache-2.0
 */

import { createClient, type Client as SqliteClient } from "@libsql/client";
import type { Env } from "@private-landing/types";

export type { SqliteClient };

/**
 * Factory function type for creating database clients.
 * Used for dependency injection to enable testing with mock clients.
 */
export type DbClientFactory = (env: Env) => SqliteClient;

/**
 * Returns true when the URL targets a local libSQL/SQLite database
 * (file path or in-memory) that does not require an auth token.
 */
function isLocalUrl(url: string): boolean {
	return url.startsWith("file:") || url === ":memory:";
}

export function createDbClient(env: Env): SqliteClient {
	const url = env.AUTH_DB_URL?.trim();
	if (!url) throw new Error("No URL");

	if (isLocalUrl(url)) {
		return createClient({ url });
	}

	const authToken = env.AUTH_DB_TOKEN?.trim();
	if (!authToken) throw new Error("No auth token provided");

	return createClient({ url, authToken });
}
