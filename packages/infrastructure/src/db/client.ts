/**
 * @file client.ts
 * Database client factory with environment-based configuration.
 *
 * @license Apache-2.0
 */

import { type Client as SqliteClient, createClient } from "@libsql/client/web";
import type { Env } from "@private-landing/types";

export type { SqliteClient };

export function createDbClient(env: Env): SqliteClient {
	const url = env.AUTH_DB_URL?.trim();
	if (!url) throw new Error("No URL");

	const authToken = env.AUTH_DB_TOKEN?.trim();
	if (!authToken) throw new Error("No auth token provided");

	return createClient({ url, authToken });
}
