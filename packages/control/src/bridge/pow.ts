/**
 * @file pow.ts
 * Proof-of-work verification, nonce management, and challenge solving
 * for the control bridge (ADR-010).
 * Plugin-only – removable with packages/control.
 *
 * @license Apache-2.0
 */

import { NONCE_TTL_MS } from "./types";

/** Seen nonces with expiry timestamps for replay prevention. */
const seenNonces = new Map<string, number>();

/** Check if a SHA-256 hash has at least `bits` leading zero bits. */
export function checkLeadingZeroBits(hash: Uint8Array, bits: number): boolean {
	let remaining = bits;
	for (let i = 0; remaining > 0 && i < hash.length; i++) {
		const byte = hash[i] ?? 0;
		if (remaining >= 8) {
			if (byte !== 0) return false;
			remaining -= 8;
		} else {
			if ((byte & (0xff << (8 - remaining))) !== 0) return false;
			remaining = 0;
		}
	}
	return true;
}

/** Solve a PoW challenge. Exported for tests. */
export async function solveChallenge(
	nonce: string,
	difficulty: number,
): Promise<string> {
	let counter = 0;
	for (;;) {
		const solution = counter.toString();
		const input = new TextEncoder().encode(nonce + solution);
		const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
		if (checkLeadingZeroBits(hash, difficulty)) return solution;
		counter++;
	}
}

/** Verify PoW: SHA-256(nonce + solution) must have `difficulty` leading zero bits. */
export async function verifyPoW(
	nonce: string,
	solution: string,
	difficulty: number,
): Promise<boolean> {
	const input = new TextEncoder().encode(nonce + solution);
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
	return checkLeadingZeroBits(hash, difficulty);
}

/** Generate a cryptographic nonce. Prunes expired entries on each call. */
export function generateNonce(): string {
	pruneNonces();
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return btoa(String.fromCharCode(...bytes));
}

/** Prune expired nonces from the seen set. */
function pruneNonces(): void {
	const now = Date.now();
	for (const [nonce, expiry] of seenNonces) {
		if (expiry <= now) seenNonces.delete(nonce);
	}
}

/** Consume a nonce (returns false if already seen — replay detected). */
export function consumeNonce(nonce: string): boolean {
	pruneNonces();
	if (seenNonces.has(nonce)) return false;
	seenNonces.set(nonce, Date.now() + NONCE_TTL_MS);
	return true;
}

/** Reset seen nonces. Exported for testing only. @internal */
export function _resetSeenNonces(): void {
	seenNonces.clear();
}
