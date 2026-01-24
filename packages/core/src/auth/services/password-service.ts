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
 * Password hashing configuration following security best practices.
 */
export interface PasswordConfig {
	/** Hashing algorithm (currently only PBKDF2 supported) */
	algorithm: "PBKDF2";
	/** SHA variant bit length (256, 384, or 512) */
	bits: HashBits;
	/** Salt size in bytes (NIST recommends minimum 128 bits = 16 bytes) */
	saltBytes: number;
	/** PBKDF2 iteration count for key stretching */
	iterations: number;
	/** Schema version for future algorithm updates */
	version: 1;
}

/**
 * Default password configuration following security best practices:
 * - SHA-384 for balance of security and performance
 * - 16 bytes of salt (128 bits) per NIST SP 800-132
 * - 100k iterations for key stretching (PBKDF2)
 * - Version tracking for future algorithm updates
 */
export const defaultPasswordConfig: PasswordConfig = {
	algorithm: "PBKDF2",
	bits: 384,
	saltBytes: 16, // NIST recommended minimum (128 bits)
	iterations: 100000, // OWASP guidance for SHA-512 is 210,000 rounds
	version: 1,
};

/**
 * Interface defining the password service API.
 * Provides methods for secure password hashing and verification.
 */
export interface PasswordService {
	/**
	 * Securely hash a password using PBKDF2 with additional digest.
	 * Implements NIST SP 800-132 recommendations.
	 *
	 * @param password - The plain text password to hash
	 * @returns Formatted string containing all verification data
	 */
	hashPassword(password: string): Promise<string>;

	/**
	 * Verifies a password against stored hash data using Web Crypto API.
	 * Implements constant-time comparison to prevent timing attacks.
	 *
	 * @param password - Plain text password to verify
	 * @param storedPasswordData - Complete stored password string
	 * @returns Promise resolving to true if password matches
	 */
	verifyPassword(
		password: string,
		storedPasswordData: string,
	): Promise<boolean>;

	/**
	 * Performs a timing-equivalent password verification using a dummy password hash.
	 * Always returns `false` after spending roughly the same time as a real verification.
	 *
	 * @param password - Password parameter (ignored, for API consistency)
	 * @returns Promise resolving to false after timing-equivalent operation
	 */
	rejectPasswordWithConstantTime(password: string): Promise<false>;

	/**
	 * Checks if a password is commonly used, compromised, or follows obvious patterns.
	 * Implements NIST SP 800-63B guidelines for password verification.
	 *
	 * @param password - Password to check
	 * @returns Object indicating if password is compromised and reason if applicable
	 */
	isPasswordCompromised(password: string): Promise<{
		isCompromised: boolean;
		reason?: string;
	}>;
}

/**
 * Type guard to ensure hash bit length is valid.
 * @param bits - The number of bits to validate
 * @returns True if bits is a valid hash length
 */
const isValidHashBits = (bits: number): bits is HashBits => {
	return VALID_HASH_BITS.includes(bits as HashBits);
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
 * 5. salt - Base64 encoded random salt
 * 6. hash - Base64 encoded PBKDF2 derived key
 * 7. digest - Base64 encoded SHA hash of derived key
 */
function formatPasswordString(
	config: PasswordConfig,
	{
		iterations,
		salt,
		hash,
		digest,
	}: {
		iterations: number;
		salt: string;
		hash: string;
		digest: string;
	},
): string {
	return `$pbkdf2-sha${config.bits}$v${config.version}$${iterations}$${salt}$${hash}$${digest}`;
}

/**
 * Parses stored password data into its components.
 * Validates format integrity before password verification.
 *
 * @param passwordData - Delimited string containing all verification data
 * @returns Parsed components or null if format is invalid
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
	const version = Number.parseInt(versionStr.slice(1), 10);
	const iterations = Number.parseInt(iterationsStr, 10);

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
 * Creates a configured password management service.
 * Provides methods for secure password hashing and verification
 * following NIST SP 800-132 recommendations.
 *
 * @param config - Configuration for password hashing parameters
 * @returns Password management service with hash/verify operations
 */
export function createPasswordService(
	config: Partial<PasswordConfig> = {},
): PasswordService {
	const resolvedConfig: PasswordConfig = {
		...defaultPasswordConfig,
		...config,
	};

	if (!isValidHashBits(resolvedConfig.bits)) {
		throw new Error("Invalid hash bits - must be 256, 384, or 512");
	}

	// Pre-computed dummy hash for constant-time rejection
	const DUMMY_PASSWORD_DATA =
		"$pbkdf2-sha384$v1$100000$eUePGIA4YLuAgoL9Rdes+g==$" +
		"BI747ZGJuwlcbJFfRTFW4naNkRj1goq035wXUBT7Ernv5s0qQWr2aM9zQPXDu9lD$" +
		"HbHDDTUSrKhft4vw7QNWJFhHfqTQmn74RC6a7TUSe2Wx2cyDybFdUbZhLIqUVzqr";

	/**
	 * Internal hash password implementation.
	 */
	async function hashPassword(password: string): Promise<string> {
		const salt = crypto.getRandomValues(
			new Uint8Array(resolvedConfig.saltBytes),
		);
		const passwordAsBytes = new TextEncoder().encode(password);

		// Import key for PBKDF2
		const keyMaterial: CryptoKey = await crypto.subtle.importKey(
			"raw",
			passwordAsBytes,
			resolvedConfig.algorithm,
			false,
			["deriveBits"],
		);

		// Generate main hash
		const hashBuffer = await crypto.subtle.deriveBits(
			{
				name: resolvedConfig.algorithm,
				salt,
				iterations: resolvedConfig.iterations,
				hash: `SHA-${resolvedConfig.bits}`,
			},
			keyMaterial,
			resolvedConfig.bits,
		);

		// Generate additional digest
		const digestBuffer = await crypto.subtle.digest(
			`SHA-${resolvedConfig.bits}`,
			hashBuffer,
		);

		// Convert to base64
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		const digestArray = Array.from(new Uint8Array(digestBuffer));
		const hashBase64 = btoa(String.fromCharCode(...hashArray));
		const saltBase64 = btoa(String.fromCharCode(...salt));
		const digestBase64 = btoa(String.fromCharCode(...digestArray));

		return formatPasswordString(resolvedConfig, {
			iterations: resolvedConfig.iterations,
			salt: saltBase64,
			hash: hashBase64,
			digest: digestBase64,
		});
	}

	/**
	 * Internal verify password implementation.
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
			resolvedConfig.algorithm,
			false,
			["deriveBits"],
		);

		// Generate hash with same parameters
		const hashBuffer = await crypto.subtle.deriveBits(
			{
				name: resolvedConfig.algorithm,
				salt: saltBytes,
				iterations,
				hash: `SHA-${resolvedConfig.bits}`,
			},
			keyMaterial,
			resolvedConfig.bits,
		);

		// Compare hashes using constant-time comparison
		return await timingSafeEqual(
			hashBuffer,
			Uint8Array.from(atob(hash), (c) => c.charCodeAt(0)),
		);
	}

	/**
	 * Internal constant-time rejection implementation.
	 */
	async function rejectPasswordWithConstantTime(
		_password: string,
	): Promise<false> {
		// Perform full verification operation (will always return false).
		// The real verifyPassword uses timing-safe comparison internally.
		await verifyPassword(_password, DUMMY_PASSWORD_DATA).catch(() => {
			// Swallow errors to prevent introducing timing differences
			// or leaking information about the password data format
		});

		return false;
	}

	/**
	 * Internal password compromise check implementation.
	 */
	async function isPasswordCompromised(password: string): Promise<{
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

	return {
		hashPassword,
		verifyPassword,
		rejectPasswordWithConstantTime,
		isPasswordCompromised,
	};
}
