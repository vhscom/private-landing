/**
 * @file index.ts
 * Main entry point for authentication system core functionality.
 * Creates and configures authentication services with database customization.
 *
 * @license Apache-2.0
 */

import type { AuthDatabaseConfig } from "@private-landing/types";
import {
	createAccountService,
	createPasswordService,
	createSessionService,
	createTokenService,
} from "./services";

/**
 * Default configuration for authentication system.
 * Provides standard table and column names.
 */
const DEFAULT_CONFIG: Required<AuthDatabaseConfig> = {
	accounts: {
		tableName: "account",
		emailColumn: "email",
		passwordColumn: "password_data",
		idColumn: "id",
	},
	sessions: {
		tableName: "session",
		idColumn: "id",
		userIdColumn: "user_id",
		userAgentColumn: "user_agent",
		ipAddressColumn: "ip_address",
		expiresAtColumn: "expires_at",
		createdAtColumn: "created_at",
	},
	migrations: {
		auto: false,
		directory: "./migrations",
	},
};

/**
 * Creates configured authentication system.
 * Initializes and connects account, session, and token services.
 *
 * @param config - Database configuration for auth system
 * @returns Configured authentication system
 */
export function createAuthSystem(config: Partial<AuthDatabaseConfig> = {}) {
	const resolvedConfig = {
		accounts: { ...DEFAULT_CONFIG.accounts, ...config.accounts },
		sessions: { ...DEFAULT_CONFIG.sessions, ...config.sessions },
		migrations: { ...DEFAULT_CONFIG.migrations, ...config.migrations },
	};

	// Create services with dependency injection
	const passwords = createPasswordService();

	return {
		passwords,
		accounts: createAccountService({
			...resolvedConfig.accounts,
			passwordService: passwords,
		}),
		sessions: createSessionService(resolvedConfig.sessions),
		tokens: createTokenService(),
		config: resolvedConfig,
	};
}

// Re-export existing functionality
export * from "./config";
export * from "./middleware";
export * from "./services";
export * from "./utils";
