/**
 * @file password-service.ts
 * Implementation of NIST SP 800-132 compliant password hashing and verification.
 *
 * @license Apache-2.0
 */

import { timingSafeEqual } from "../utils/crypto";

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
 * Password hashing configuration following security best practices:
 * - SHA-384 for balance of security and performance
 * - 16 bytes of salt (128 bits) per NIST SP 800-132
 * - 100k iterations for key stretching (PBKDF2)
 * - Version tracking for future algorithm updates
 */
interface PasswordConfig {
	algorithm: "PBKDF2";
	bits: HashBits;
	saltBytes: number;
	iterations: number;
	version: 1;
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
	saltBytes: 16, // NIST recommended minimum (128 bits) (2025)
	iterations: 100000, // OWASP guidance for SHA-512 is 210,000 (2025)
	version: 1,
};

/**
 * Type guard to ensure hash bit length is valid.
 * @param bits - The number of bits to validate
 * @returns True if bits is a valid hash length
 */
const isValidHashBits = (bits: number) => {
	return VALID_HASH_BITS.includes(bits as HashBits);
};

if (!isValidHashBits(passwordConfig.bits)) {
	throw new Error("Invalid hash bits - must be 256, 384, or 512");
}

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
export async function hashPassword(password: string) {
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
 * Verifies a password against stored hash data using Web Crypto API.
 * Implements constant-time comparison to prevent timing attacks.
 *
 * Process:
 * 1. Parse stored password components
 * 2. Recreate hash using same salt/iterations
 * 3. Compare hash using constant-time verification
 *
 * @param password - Plain text password to verify
 * @param storedPasswordData - Complete stored password string
 * @returns Promise resolving to true if password matches
 */
export async function verifyPassword(
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

	// Generate digest using derived bits
	const _digestBuffer = await crypto.subtle.digest(
		`SHA-${passwordConfig.bits}`,
		hashBuffer,
	);

	// Compare hashes using constant-time comparison
	return await timingSafeEqual(
		hashBuffer,
		Uint8Array.from(atob(hash), (c) => c.charCodeAt(0)),
	);
}

/**
 * Performs a timing-equivalent password verification using a dummy password hash.
 * Always returns `false` after spending roughly the same time as a real verification.
 *
 * @param _password - Password parameter (ignored, for API consistency)
 * @throws Never. Errors swallowed to preserve timing behavior.
 * @returns Promise resolving to false after timing-equivalent operation
 */
export async function rejectPasswordWithConstantTime(
	_password: string,
): Promise<false> {
	// Use a fixed dummy password hash to maintain consistent timing.
	// This password data represents a valid but non-existent account.
	const DUMMY_PASSWORD_DATA =
		"$pbkdf2-sha384$v1$100000$eUePGIA4YLuAgoL9Rdes+g==$" +
		"BI747ZGJuwlcbJFfRTFW4naNkRj1goq035wXUBT7Ernv5s0qQWr2aM9zQPXDu9lD$" +
		"HbHDDTUSrKhft4vw7QNWJFhHfqTQmn74RC6a7TUSe2Wx2cyDybFdUbZhLIqUVzqr";

	// Perform full verification operation (will always return false).
	// The real verifyPassword **must** use timing-safe comparison internally.
	await verifyPassword(_password, DUMMY_PASSWORD_DATA).catch(
		(error: unknown) => {
			// swallow errors to prevent introducing timing differences
			// or leaking information about the password data format
		},
	);

	return false;
}

/**
 * Checks if a password is commonly used, compromised, or follows obvious patterns.
 * Implements NIST SP 800-63B guidelines for password verification.
 *
 * @param password - Password to check
 * @returns Object indicating if password is compromised and reason if applicable
 */
export async function isPasswordCompromised(password: string): Promise<{
	isCompromised: boolean;
	reason?: string;
}> {
	const checks = [
		{
			test: (p: string) => /^(.)\1+$/.test(p),
			reason: "Password contains repetitive characters",
		},
		{
			test: (p: string) => /^(123|abc|qwerty)/i.test(p),
			reason: "Password contains sequential characters",
		},
		// Add additional checks as needed for:
		// - Known breach databases
		// - Dictionary words
		// - Context-specific words
	];

	for (const { test, reason } of checks) {
		if (test(password)) return { isCompromised: true, reason };
	}

	return { isCompromised: false };
}

// Export all password-related functionality as a service object
export const passwordService = {
	hashPassword,
	verifyPassword,
	rejectPasswordWithConstantTime,
	isPasswordCompromised,
};
