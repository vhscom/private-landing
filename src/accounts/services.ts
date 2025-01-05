import type { ResultSet } from "@libsql/client";
import { createDbClient } from "../db.ts";

/**
 * Valid bit lengths for hash algorithms.
 * Must match available SHA variants (SHA-256, SHA-384, SHA-512).
 * Using SHA-384 for balance of security and performance.
 */
const VALID_HASH_BITS = [256, 384, 512] as const;
type HashBits = (typeof VALID_HASH_BITS)[number];

/**
 * Configuration for password hashing.
 * Based on NIST SP 800-132 recommendations.
 */
interface PasswordConfig {
	algorithm: "PBKDF2";
	bits: HashBits; // Hash output size
	saltBytes: number; // Size of random salt
	iterations: number; // PBKDF2 iterations
	version: 1; // Schema version for upgrades
}

/**
 * Error type for password validation failures.
 * Includes field information for UI feedback.
 */
interface PasswordValidationError extends Error {
	code: "VALIDATION_ERROR";
	field: string;
}

/**
 * Creates a typed validation error.
 * @param message - User-friendly error message
 * @param field - Form field that failed validation
 */
function createValidationError(
	message: string,
	field: string,
): PasswordValidationError {
	const error = new Error(message) as PasswordValidationError;
	error.code = "VALIDATION_ERROR";
	error.field = field;
	return error;
}

/**
 * Type guard to ensure hash bit length is valid.
 * @param bits - The number of bits to validate
 * @returns True if bits is a valid hash length
 */
function isValidHashBits(bits: number): bits is HashBits {
	return VALID_HASH_BITS.includes(bits as HashBits);
}

/**
 * Password hashing configuration following security best practices:
 * - SHA-384 for balance of security and performance
 * - 16 bytes of salt (128 bits) per NIST SP 800-132
 * - 100k iterations for key stretching (PBKDF2)
 * - Version tracking for future algorithm updates
 */
const passwordConfig: PasswordConfig = {
	algorithm: "PBKDF2",
	bits: 384,
	saltBytes: 16, // NIST recommended minimum (128 bits)
	iterations: 100000,
	version: 1,
};

if (!isValidHashBits(passwordConfig.bits)) {
	throw new Error("Invalid hash bits - must be 256, 384, or 512");
}

/**
 * Service interface for account management operations.
 */
interface AccountService {
	createAccount: (
		email: string,
		password: string,
		env: Env,
	) => Promise<ResultSet>;
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
};

/**
 * Creates a formatted string containing all password verification data.
 * Format: $pbkdf2-shaXXX$v1$iterations$salt$hash$digest
 *
 * Example:
 * $pbkdf2-sha384$v1$100000$<base64-salt>$<base64-hash>$<base64-digest>
 *
 * This format includes:
 * - Algorithm identifier with hash bits
 * - Version number for future upgrades
 * - Iteration count for PBKDF2
 * - Base64 encoded salt (128 bits)
 * - Base64 encoded hash
 * - Base64 encoded additional digest
 *
 * @param params Object containing values to format
 * @returns Delimited string containing all verification data
 */
function formatPasswordString({
	iterations,
	salt,
	hash,
	digest,
}: {
	iterations: number;
	salt: string;
	hash: string;
	digest: string;
}): string {
	return `$pbkdf2-sha${passwordConfig.bits}$v${passwordConfig.version}$${iterations}$${salt}$${hash}$${digest}`;
}

/**
 * Securely hash a password using PBKDF2 with additional digest.
 * Implements NIST SP 800-132 recommendations for:
 * - Salt size (128 bits)
 * - Strong hash function (SHA-384)
 * - Key stretching (100k iterations)
 *
 * Also includes an additional SHA-384 digest of the hash
 * for extra verification capability.
 *
 * @param password - The plain text password to hash
 * @returns Formatted string containing all verification data
 */
async function hashPassword(password: string) {
	const salt = crypto.getRandomValues(new Uint8Array(passwordConfig.saltBytes));
	const passwordAsBytes = new TextEncoder().encode(password);

	// Import key for PBKDF2
	const keyMaterial: CryptoKey = await crypto.subtle.importKey(
		"raw",
		passwordAsBytes,
		passwordConfig.algorithm,
		false,
		["deriveBits"],
	);

	// Generate main hash
	const hashBuffer = await crypto.subtle.deriveBits(
		{
			name: passwordConfig.algorithm,
			salt,
			iterations: passwordConfig.iterations,
			hash: `SHA-${passwordConfig.bits}`,
		},
		keyMaterial,
		passwordConfig.bits,
	);

	// Generate additional digest
	const digestBuffer = await crypto.subtle.digest(
		`SHA-${passwordConfig.bits}`,
		hashBuffer,
	);

	// Convert to base64
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const digestArray = Array.from(new Uint8Array(digestBuffer));
	const hashBase64 = btoa(String.fromCharCode(...hashArray));
	const saltBase64 = btoa(String.fromCharCode(...salt));
	const digestBase64 = btoa(String.fromCharCode(...digestArray));

	return formatPasswordString({
		iterations: passwordConfig.iterations,
		salt: saltBase64,
		hash: hashBase64,
		digest: digestBase64,
	});
}
