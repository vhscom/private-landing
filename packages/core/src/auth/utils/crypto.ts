/**
 * @file crypto.ts
 * Exports cryptographic auth utilities.
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
	const aBytes = (ArrayBuffer.isView(a) ? a.buffer : a) as ArrayBuffer;
	const bBytes = (ArrayBuffer.isView(b) ? b.buffer : b) as ArrayBuffer;

	const lengthsMatch = aBytes.byteLength === bBytes.byteLength;

	// Pad both to the same length so the HMAC comparison always runs,
	// preventing timing side-channels from leaking input lengths.
	const maxLen = Math.max(aBytes.byteLength, bBytes.byteLength) || 1;
	const aPadded = new Uint8Array(maxLen);
	aPadded.set(new Uint8Array(aBytes));
	const bPadded = new Uint8Array(maxLen);
	bPadded.set(new Uint8Array(bBytes));

	const algorithm = { name: "HMAC", hash: "SHA-256" };
	const key = (await crypto.subtle.generateKey(algorithm, false, [
		"sign",
		"verify",
	])) as CryptoKey;
	const hmac = await crypto.subtle.sign(algorithm, key, aPadded);
	const contentsMatch = await crypto.subtle.verify(
		algorithm,
		key,
		hmac,
		bPadded,
	);

	return lengthsMatch && contentsMatch;
}
