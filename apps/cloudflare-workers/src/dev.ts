/// <reference types="@types/bun" />
/**
 * @file dev.ts
 * Unified dev entry point. Delegates to wrangler when .dev.vars exists,
 * otherwise starts a zero-config Bun dev server with local SQLite.
 *
 * Usage: bun apps/cloudflare-workers/src/dev.ts
 *
 * @license Apache-2.0
 */

const APP_DIR = `${import.meta.dir}/..`;
const PORT = 8788;

const local = process.argv.includes("--local");
const hasDevVars = await Bun.file(`${APP_DIR}/.dev.vars`).exists();

if (hasDevVars && !local) {
	const proc = Bun.spawn(["bunx", "wrangler", "dev", "--port", String(PORT)], {
		cwd: APP_DIR,
		stdio: ["inherit", "inherit", "inherit"],
	});
	await proc.exited;
	process.exit(proc.exitCode ?? 0);
}

// Zero-config local dev server
import { createClient } from "@libsql/client";

const DB_DIR = `${APP_DIR}/.wrangler/state`;
const DB_PATH = `${DB_DIR}/local.db`;
const PUBLIC_DIR = `${APP_DIR}/public`;

await Bun.$`mkdir -p ${DB_DIR}`;

const db = createClient({ url: `file:${DB_PATH}` });
await db.executeMultiple(`
CREATE TABLE IF NOT EXISTS account (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_data TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES account(id),
  user_agent TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_user ON session(user_id);
CREATE INDEX IF NOT EXISTS idx_session_expiry ON session(expires_at);
CREATE INDEX IF NOT EXISTS idx_session_user_expiry ON session(user_id, expires_at);
`);
db.close();

const { default: app } = await import("./app");

const devEnv = {
	ENVIRONMENT: "development",
	AUTH_DB_URL: `file:${DB_PATH}`,
	JWT_ACCESS_SECRET: "dev-access-secret-do-not-use-in-production",
	JWT_REFRESH_SECRET: "dev-refresh-secret-do-not-use-in-production",
};

const executionCtx: ExecutionContext = {
	waitUntil: (p: Promise<unknown>) => {
		p.catch(() => {});
	},
	passThroughOnException: () => {},
	abort: () => {},
	props: undefined as unknown,
	exports: {} as Cloudflare.Exports,
};

console.log(`Local dev server: http://localhost:${PORT}`);
console.log(`SQLite database:  ${DB_PATH}`);

export default {
	port: PORT,
	async fetch(req: Request) {
		const url = new URL(req.url);
		const filePath = `${PUBLIC_DIR}/${url.pathname === "/" ? "index.html" : url.pathname}`;
		const file = Bun.file(filePath);
		if (await file.exists()) return new Response(file);
		return app.fetch(req, devEnv, executionCtx);
	},
};
