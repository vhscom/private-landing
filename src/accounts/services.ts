import type { ResultSet } from "@libsql/client";
import { createDbClient } from "../db.ts";

/**
 * Valid bit lengths for hash algorithms.
 * Must match available SHA variants (SHA-256, SHA-384, SHA-512).
 */
const VALID_HASH_BITS = [256, 384, 512] as const;
type HashBits = (typeof VALID_HASH_BITS)[number];

/**
 * Configuration for password hashing.
 */
interface PasswordConfig {
	algorithm: "PBKDF2";
	bits: HashBits;
	saltBytes: number;
	iterations: number;
	version: 1;
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
 * Password hashing configuration.
 * - SHA-384 for balance of security and performance
 * - 12 bytes of salt (96 bits)
 * - 100k iterations for key stretching
 * - Version 1 of the hashing scheme
 */
const passwordConfig: PasswordConfig = {
	algorithm: "PBKDF2",
	bits: 384,
	saltBytes: 12,
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
		const passwordData = await hashPassword(password);
		const dbClient = createDbClient(env);
		return dbClient.execute({
			sql: "INSERT INTO accounts (email, password_data) VALUES (?, ?)",
			args: [email, passwordData],
		});
	},
};

/**
 * Creates a formatted string containing all password verification data.
 * Format: $pbkdf2-shaXXX$v1$iterations$salt$hash$digest
 * @param params - Object containing formatted values
 * @returns Delimited string of password data
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
 * Returns a formatted string containing all verification data.
 * @param password - The plain text password to hash
 * @returns Formatted string containing algorithm, iterations, salt, hash, and digest
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
