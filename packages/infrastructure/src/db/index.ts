/**
 * @file index.ts
 * Exports infrastructure database components.
 *
 * @license Apache-2.0
 */

export {
	createDbClient,
	type DbClientFactory,
	type SqliteClient,
} from "./client";
