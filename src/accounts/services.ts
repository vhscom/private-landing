import { createDbClient } from "../db.ts";
import type { ResultSet } from "@libsql/client";

/**
 * Valid bit lengths for hash algorithms.
 * Must match available SHA variants (SHA-256, SHA-384, SHA-512).
 */
const VALID_HASH_BITS = [256, 384, 512] as const;
type HashBits = (typeof VALID_HASH_BITS)[number];

/**
 * Type guard to ensure hash bit length is valid.
 * @param bits - The number of bits to validate
 * @returns True if bits is a valid hash length
 */
function isValidHashBits(bits: number): bits is HashBits {
	return VALID_HASH_BITS.includes(bits as HashBits);
}

/**
 * Hash bit length for password hashing.
 * Uses SHA-384 for a balance of security and performance.
 */
const HASH_BITS = 384;
if (!isValidHashBits(HASH_BITS)) {
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
		const { hash, salt } = await hashPassword(password);
		const dbClient = createDbClient(env);
		return dbClient.execute({
			sql: "INSERT INTO accounts (email, password_hash, salt) VALUES (?, ?, ?)",
			args: [email, hash, salt],
		});
	},
};

/**
 * Securely hash a password using PBKDF2.
 * @param password - The plain text password to hash
 * @returns Object containing base64 encoded hash and salt
 */
async function hashPassword(password: string) {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const passwordAsBytes = new TextEncoder().encode(password);
	const passwordKey: CryptoKey = await crypto.subtle.importKey(
		"raw",
		passwordAsBytes,
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const hashBuffer = await crypto.subtle.deriveBits(
		{
			name: "PBKDF2",
			salt,
			iterations: 100000,
			hash: `SHA-${HASH_BITS}`,
		},
		passwordKey,
		HASH_BITS,
	);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hashBase64 = btoa(String.fromCharCode(...hashArray));
	const saltBase64 = btoa(String.fromCharCode(...salt));
	return { hash: hashBase64, salt: saltBase64 };
}
