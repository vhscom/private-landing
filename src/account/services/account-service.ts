import type { ResultSet } from "@libsql/client";
import { createDbClient } from "../../infrastructure/db/client.ts";
import { createValidationError } from "../../utils/errors.ts";
import { hashPassword, verifyPassword } from "./password-service.ts";

/**
 * Result of an authentication attempt.
 * @property authenticated - Whether the credentials were valid
 * @property userId - The user's ID if authentication succeeded, null otherwise
 */
interface AuthResult {
	authenticated: boolean;
	userId?: number | null;
}

/**
 * Service interface for account management operations.
 */
interface AccountService {
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
	 * @param email - User's email address (unique identifier)
	 * @param password - Plain text password to hash and store
	 * @param env - Environment containing database connection
	 * @returns Database result with affected rows and insert ID
	 * @throws PasswordValidationError if password requirements not met
	 */
	createAccount: (
		email: string,
		password: string,
		env: Env,
	) => Promise<ResultSet>;

	/**
	 * Authenticates a user with email and password.
	 * Performs constant-time password verification to prevent timing attacks.
	 *
	 * @param email - User's email address
	 * @param password - Plain text password to verify
	 * @param env - Environment containing database connection
	 * @returns Authentication result containing success status and user ID
	 */
	authenticate: (
		email: string,
		password: string,
		env: Env,
	) => Promise<AuthResult>;
}

export const accountService: AccountService = {
	createAccount: async (email: string, password: string, env: Env) => {
		// Minimum of 8 character passwords per NIST SP 800-63-3
		if (password.length < 8) {
			throw createValidationError(
				"Password must be at least 8 characters long",
				"password",
			);
		}
		const passwordData = await hashPassword(password);
		const dbClient = createDbClient(env);
		return dbClient.execute({
			sql: "INSERT INTO account (email, password_data) VALUES (?, ?)",
			args: [email, passwordData],
		});
	},

	authenticate: async (email: string, password: string, env: Env) => {
		const dbClient = createDbClient(env);
		const result = await dbClient.execute({
			sql: "SELECT password_data, id FROM account WHERE email = ?",
			args: [email],
		});

		if (result.rows.length === 0) {
			return { authenticated: false, userId: null };
		}

		const row = result.rows[0];
		const storedPasswordData = row.password_data as string;
		const isValid = await verifyPassword(password, storedPasswordData);

		if (!isValid) {
			return { authenticated: false, userId: null };
		}

		const userId = typeof row.id === "number" ? row.id : null;
		return { authenticated: true, userId };
	},
};
