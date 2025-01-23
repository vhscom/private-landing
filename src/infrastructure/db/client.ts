/**
 * @file client.ts
 * Database client factory with environment-based configuration.
 *
 * @license LGPL-3.0-or-later
 */

import { type Client as SqliteClient, createClient } from "@libsql/client/web";

export type { SqliteClient };

export function createDbClient(env: Env): SqliteClient {
	const url = env.TURSO_URL?.trim();
	if (!url) throw new Error("No URL");

	const authToken = env.TURSO_AUTH_TOKEN?.trim();
	if (!authToken) throw new Error("No auth token provided");

	return createClient({ url, authToken });
}
