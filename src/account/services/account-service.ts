/**
 * @file account-service.ts
 * Service for managing user accounts and authentication with secure password handling.
 * Implements NIST SP 800-63B requirements for memorized secrets.
 *
 * @license LGPL-3.0-or-later
 */

import type { ResultSet } from "@libsql/client";
import {
	loginSchema,
	registrationSchema,
} from "../../auth/schemas/auth.schema.ts";
import type {
	AuthResult,
	LoginInput,
	RegistrationInput,
} from "../../auth/types/auth.types.ts";
import { ValidationError } from "../../auth/utils/errors.ts";
import { formatZodError } from "../../auth/utils/schema.ts";
import { createDbClient } from "../../infrastructure/db/client.ts";
import { hashPassword, verifyPassword } from "./password-service.ts";

/**
 * Service for account management operations.
 * Provides methods for account creation and authentication
 * following NIST security guidelines.
 */
export const accountService = {
	/**
	 * Creates a new user account with secure password storage.
	 * Implements NIST SP 800-63-3 password requirements and
	 * NIST SP 800-132 password hashing recommendations.
	 *
	 * Process:
	 * 1. Validates password meets minimum requirements
	 * 2. Generates cryptographically secure salt
	 * 3. Applies PBKDF2 key derivation with SHA-384
	 * 4. Generates additional integrity digest
	 * 5. Stores combined password data in database
	 *
	 * @param input - Registration data including email and password
	 * @param env - Environment containing database connection
	 * @returns Database result with affected rows and insert ID
	 * @throws ValidationError Error if input cannot be parsed
	 */
	createAccount: async (
		input: RegistrationInput,
		env: Env,
	): Promise<ResultSet> => {
		const parseResult = await registrationSchema.safeParseAsync(input);

		if (!parseResult.success) {
			throw new ValidationError(formatZodError(parseResult.error));
		}

		const validatedData = parseResult.data;
		const passwordData = await hashPassword(validatedData.password);

		const dbClient = createDbClient(env);
		return dbClient.execute({
			sql: "INSERT INTO account (email, password_data) VALUES (?, ?)",
			args: [validatedData.email, passwordData],
		});
	},

	/**
	 * Authenticates a user with email and password.
	 * Performs constant-time password verification to prevent timing attacks.
	 *
	 * @param input - Login credentials including email and password
	 * @param env - Environment containing database connection
	 * @returns Authentication result containing success status and user ID
	 */
	authenticate: async (input: LoginInput, env: Env): Promise<AuthResult> => {
		const parseResult = await loginSchema.safeParseAsync(input);
		if (!parseResult.success) {
			return {
				authenticated: false,
				userId: null,
				error: formatZodError(parseResult.error),
			};
		}

		const validatedData = parseResult.data;
		const dbClient = createDbClient(env);

		const result = await dbClient.execute({
			sql: "SELECT password_data, id FROM account WHERE email = ?",
			args: [validatedData.email],
		});

		if (result.rows.length === 0) {
			return {
				authenticated: false,
				userId: null,
				error: "Invalid email or password",
			};
		}

		const [accountRow] = result.rows;
		const storedPasswordData = accountRow.password_data as string;
		const isValid = await verifyPassword(
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

		const userId = typeof accountRow.id === "number" ? accountRow.id : null;
		return {
			authenticated: true,
			userId,
		};
	},
};
