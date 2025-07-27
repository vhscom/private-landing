/**
 * @file index.ts
 * Main entry point for infrastructure functionality.
 *
 * @license Apache-2.0
 */

export { createDbClient, type SqliteClient } from "./db";
export { serveStatic, type ServeStaticOptions } from "./middleware";
