/**
 * @file index.ts
 * Main entry point for infrastructure functionality.
 *
 * @license LGPL-3.0-or-later
 */

export { createDbClient, type SqliteClient } from "./db";
export { serveStatic, type ServeStaticOptions } from "./middleware";
