/**
 * @file account-service.ts
 * Service for managing user accounts and authentication.
 * Implements NIST SP 800-63B requirements for secure credential handling.
 *
 * Features:
 * - Configurable table and column names
 * - NIST-compliant password handling
 * - Secure account creation and authentication
 * - Type-safe database operations
 *
 * @license Apache-2.0
 */

import type { ResultSet } from "@libsql/client";
import { ValidationError } from "@private-landing/errors";
import {
	type DbClientFactory,
	createDbClient as defaultCreateDbClient,
} from "@private-landing/infrastructure";
import {
	formatZodError,
	loginSchema,
	registrationSchema,
} from "@private-landing/schemas";
import type {
	AccountTable,
	AccountTableConfig,
	AuthResult,
	Env,
	LoginInput,
	RegistrationInput,
} from "@private-landing/types";
import {
	type PasswordService,
	createPasswordService,
} from "./password-service";

/**
 * Interface defining the account service API.
 * Provides methods for account management and authentication.
 */
export interface AccountService {
	/**
	 * Creates a new user account with secure password storage.
	 * Implements NIST SP 800-63B requirements for memorized secrets.
	 *
	 * @param input - Registration data including email and password
	 * @param env - Environment containing database connection
	 * @returns Database result with affected rows and insert ID
	 * @throws ValidationError if input cannot be parsed
	 */
	createAccount(input: RegistrationInput, env: Env): Promise<ResultSet>;

	/**
	 * Authenticates a user with email and password.
	 * Implements constant-time password verification to prevent timing attacks.
	 *
	 * @param input - Login credentials including email and password
	 * @param env - Environment containing database connection
	 * @returns Authentication result with success status and user ID
	 */
	authenticate(input: LoginInput, env: Env): Promise<AuthResult>;
}

/**
 * Configuration options for account service.
 */
export interface AccountServiceConfig extends AccountTableConfig {
	/** Optional password service instance for dependency injection */
	passwordService?: PasswordService;
	/** Optional database client factory for dependency injection */
	createDbClient?: DbClientFactory;
}

/**
 * Default table and column names for account management.
 * Can be overridden through AccountTableConfig.
 */
const DEFAULT_TABLE_CONFIG: Required<AccountTableConfig> = {
	tableName: "account",
	emailColumn: "email",
	passwordColumn: "password_data",
	idColumn: "id",
};

/**
 * Creates a configured account management service.
 * Provides methods for account creation and authentication
 * with support for custom table schemas.
 *
 * @param config - Configuration for account table schema and dependencies
 * @returns Account management service with CRUD operations
 */
export function createAccountService(
	config: AccountServiceConfig = {},
): AccountService {
	const {
		passwordService: injectedPasswordService,
		createDbClient: injectedCreateDbClient,
		...tableConfig
	} = config;
	const resolvedConfig = { ...DEFAULT_TABLE_CONFIG, ...tableConfig };
	const passwords = injectedPasswordService ?? createPasswordService();
	const createDbClient = injectedCreateDbClient ?? defaultCreateDbClient;

	return {
		async createAccount(
			input: RegistrationInput,
			env: Env,
		): Promise<ResultSet> {
			const parseResult = await registrationSchema.safeParseAsync(input);

			if (!parseResult.success) {
				throw new ValidationError(formatZodError(parseResult.error));
			}

			// Schema implements NIST SP 800-63B requirements for memorized secrets
			const validatedData = parseResult.data;
			const passwordData = await passwords.hashPassword(validatedData.password);

			const dbClient = createDbClient(env);
			return dbClient.execute({
				sql: `INSERT INTO ${resolvedConfig.tableName} (
					${resolvedConfig.emailColumn},
					${resolvedConfig.passwordColumn}
				) VALUES (?, ?)`,
				args: [validatedData.email, passwordData],
			});
		},

		async authenticate(input: LoginInput, env: Env): Promise<AuthResult> {
			const parseResult = await loginSchema.safeParseAsync(input);
			if (!parseResult.success) {
				return {
					authenticated: false,
					userId: null,
					error: formatZodError(parseResult.error),
				};
			}

			// Schema implements NIST SP 800-63B requirements for memorized secrets
			const validatedData = parseResult.data;
			const dbClient = createDbClient(env);

			const result = await dbClient.execute({
				sql: `SELECT ${resolvedConfig.passwordColumn}, ${resolvedConfig.idColumn}
					  FROM ${resolvedConfig.tableName}
					  WHERE ${resolvedConfig.emailColumn} = ?`,
				args: [validatedData.email],
			});

			// Timing-safe rejection: perform dummy PBKDF2 operation when user
			// doesn't exist. This equalizes response time with actual password
			// verification to prevent timing-based user enumeration attacks.
			if (result.rows.length === 0) {
				await passwords.rejectPasswordWithConstantTime(validatedData.password);
				return {
					authenticated: false,
					userId: null,
					error: "Invalid email or password",
				};
			}

			const [accountRow] = result.rows as Partial<AccountTable>[];
			const storedPasswordData = accountRow[
				resolvedConfig.passwordColumn as keyof AccountTable
			] as string;

			const isValid = await passwords.verifyPassword(
				validatedData.password,
				storedPasswordData,
			);

			if (!isValid) {
				return {
					authenticated: false,
					userId: null,
					error: "Invalid email or password",
				};
			}

			// Ensure userId is a number, if not return unauthenticated
			if (typeof accountRow.id !== "number") {
				return {
					authenticated: false,
					userId: null,
					error: "Invalid account state",
				};
			}

			return {
				authenticated: true,
				userId: accountRow.id,
			};
		},
	};
}
