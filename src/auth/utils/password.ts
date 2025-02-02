/**
 * @file password.ts
 * Password validation utilities following NIST SP 800-63B guidelines.
 * Includes Unicode normalization and common password detection.
 *
 * @license LGPL-3.0-or-later
 */

/**
 * Normalizes a password string according to NIST SP 800-63B requirements.
 * Applies NFKC normalization for Unicode stability and space normalization.
 *
 * @param password - Raw password string to normalize
 * @returns Normalized password string
 */
export function normalizePassword(password: string): string {
	return password.normalize("NFKC").replace(/\s+/g, " ");
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
