/**
 * @file crypto.ts
 * Exports cryptographic auth utililties.
 *
 * @license Apache-2.0
 */

/**
 * Constant-time equality comparison using double HMAC pattern.
 * Works across all environments (browsers, Node, Cloudflare Workers).
 * Uses crypto.subtle.verify() which is required by spec to be constant-time.
 *
 * @param a - First value to compare
 * @param b - Second value to compare
 * @returns Promise resolving to true if values are equal
 */
export async function timingSafeEqual(
	a: BufferSource,
	b: BufferSource,
): Promise<boolean> {
	const aBytes = ArrayBuffer.isView(a) ? a.buffer : a;
	const bBytes = ArrayBuffer.isView(b) ? b.buffer : b;

	if (aBytes.byteLength !== bBytes.byteLength) return false;

	const algorithm = { name: "HMAC", hash: "SHA-256" };
	const key = (await crypto.subtle.generateKey(algorithm, false, [
		"sign",
		"verify",
	])) as CryptoKey;
	const hmac = await crypto.subtle.sign(algorithm, key, aBytes);
	return await crypto.subtle.verify(algorithm, key, hmac, bBytes);
}
