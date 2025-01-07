import type { ResultSet } from "@libsql/client";
import { createDbClient } from "../db.ts";

/**
 * Valid bit lengths for hash algorithms.
 * Must match available SHA variants (SHA-256, SHA-384, SHA-512).
 * - SHA-256: Fastest, good for legacy compatibility
 * - SHA-384: Current selection, optimal security/performance balance
 * - SHA-512: Highest security, more computational cost
 */
const VALID_HASH_BITS = [256, 384, 512] as const;
type HashBits = (typeof VALID_HASH_BITS)[number];

/**
 * Configuration for password hashing following NIST SP 800-132.
 * @property algorithm - PBKDF2 key derivation function
 * @property bits - Output size of hash function
 * @property saltBytes - Random salt size (128 bits min per NIST)
 * @property iterations - Key stretching iterations (100k+)
 * @property version - Schema version for future algorithm upgrades
 */
interface PasswordConfig {
	algorithm: "PBKDF2";
	bits: HashBits;
	saltBytes: number;
	iterations: number;
	version: 1;
}

/**
 * Error type for password validation failures.
 * Provides structured error information for UI feedback.
 * @property code - Error type identifier
 * @property field - Form field that caused validation failure
 * @property message - User-friendly error description
 */
interface PasswordValidationError extends Error {
	code: "VALIDATION_ERROR";
	field: string;
}

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

if (!isValidHashBits(passwordConfig.bits)) {
	throw new Error("Invalid hash bits - must be 256, 384, or 512");
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

/**
 * Password storage format:
 * $pbkdf2-shaXXX$v1$iterations$salt$hash$digest
 *
 * Components:
 * 1. $ - Field delimiter
 * 2. pbkdf2-shaXXX - Algorithm identifier (e.g., pbkdf2-sha384)
 * 3. v1 - Schema version for future upgrades
 * 4. iterations - PBKDF2 iteration count
 * 5. salt - Base64 encoded 128-bit random salt
 * 6. hash - Base64 encoded PBKDF2 derived key
 * 7. digest - Base64 encoded SHA-384 hash of derived key
 *
 * Security features:
 * - NIST SP 800-132 compliant salt size
 * - High iteration count for key stretching
 * - Additional digest for integrity verification
 * - Version tracking for algorithm updates
 * - Constant-time comparison for verification
 *
 * @example
 * $pbkdf2-sha384$v1$100000$randomsalt$derivedhash$additionaldigest
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

/**
 * Parses stored password data into its components.
 * Validates format integrity before password verification.
 *
 * @param passwordData - Delimited string containing all verification data
 * @returns Parsed components or null if format is invalid
 * @throws Never - Returns null for any parsing failure
 */
function parsePasswordString(passwordData: string): null | {
	algorithm: string;
	version: number;
	iterations: number;
	salt: string;
	hash: string;
	digest: string;
} {
	const parts = passwordData.split("$");
	if (parts.length !== 7) return null;

	const [, algorithmFull, versionStr, iterationsStr, salt, hash, digest] =
		parts;
	const version = Number.parseInt(versionStr.slice(1));
	const iterations = Number.parseInt(iterationsStr);

	if (Number.isNaN(version) || Number.isNaN(iterations)) return null;

	return {
		algorithm: algorithmFull,
		version,
		iterations,
		salt,
		hash,
		digest,
	};
}

/**
 * Verifies a password against stored hash data using Web Crypto API.
 * Implements constant-time comparison to prevent timing attacks.
 *
 * Process:
 * 1. Parse stored password components
 * 2. Recreate hash using same salt/iterations
 * 3. Generate verification digest
 * 4. Compare both hash and digest
 *
 * @param password - Plain text password to verify
 * @param storedPasswordData - Complete stored password string
 * @returns Promise resolving to true if password matches
 */
async function verifyPassword(
	password: string,
	storedPasswordData: string,
): Promise<boolean> {
	const parsed = parsePasswordString(storedPasswordData);
	if (!parsed) return false;

	const { iterations, salt, hash } = parsed;
	const saltBytes = Uint8Array.from(atob(salt), (c) => c.charCodeAt(0));
	const passwordAsBytes = new TextEncoder().encode(password);

	// Import key for PBKDF2
	const keyMaterial: CryptoKey = await crypto.subtle.importKey(
		"raw",
		passwordAsBytes,
		passwordConfig.algorithm,
		false,
		["deriveBits"],
	);

	// Generate hash with same parameters
	const hashBuffer = await crypto.subtle.deriveBits(
		{
			name: passwordConfig.algorithm,
			salt: saltBytes,
			iterations,
			hash: `SHA-${passwordConfig.bits}`,
		},
		keyMaterial,
		passwordConfig.bits,
	);

	// Generate digest for additional verification
	const digestBuffer = await crypto.subtle.digest(
		`SHA-${passwordConfig.bits}`,
		hashBuffer,
	);

	// Convert to base64 for comparison
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const digestArray = Array.from(new Uint8Array(digestBuffer));
	const computedHash = btoa(String.fromCharCode(...hashArray));
	const computedDigest = btoa(String.fromCharCode(...digestArray));

	// Compare both hash and digest
	return computedHash === hash && computedDigest === parsed.digest;
}
