/**
 * @file password.ts
 * Password handling utilities following NIST SP 800-63B requirements.
 *
 * @license Apache-2.0
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
