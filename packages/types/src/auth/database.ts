/**
 * @file database.ts
 * Authentication database types and configuration.
 * Defines required database structure and configuration options.
 *
 * @license Apache-2.0
 */

/**
 * Account table structure.
 * Core user identity and credentials storage.
 */
export interface AccountTable {
	id: number;
	email: string;
	password_data: string;
	created_at: string;
}

/**
 * Session table structure.
 * Active session tracking and management.
 */
export interface SessionTable {
	id: string;
	user_id: number;
	user_agent: string;
	ip_address: string;
	expires_at: string;
	created_at: string;
}

/**
 * Account table configuration options.
 * Allows customization of the authentication database schema.
 */
export interface AccountTableConfig {
	tableName?: string; // Default: 'account'
	emailColumn?: string; // Default: 'email'
	passwordColumn?: string; // Default: 'password_data'
	idColumn?: string; // Default: 'id'
}

/**
 * Session table configuration options.
 * Allows customization of the session table schema.
 */
export interface SessionTableConfig {
	tableName?: string; // Default: 'session'
	idColumn?: string; // Default: 'id'
	userIdColumn?: string; // Default: 'user_id'
	userAgentColumn?: string; // Default: 'user_agent'
	ipAddressColumn?: string; // Default: 'ip_address'
	expiresAtColumn?: string; // Default: 'expires_at'
	createdAtColumn?: string; // Default: 'created_at'
}

/**
 * Authentication database configuration.
 * Required for initializing the authentication system.
 */
export interface AuthDatabaseConfig {
	accounts: AccountTableConfig;
	sessions: SessionTableConfig;
	migrations?: {
		auto?: boolean; // Whether to auto-run migrations
		directory?: string; // Custom migrations directory
	};
}
