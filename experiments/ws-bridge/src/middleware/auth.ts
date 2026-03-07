/**
 * @file auth.ts
 * Agent credential store and verification. In-memory prototype of the
 * agent_credential table used by packages/observability/src/require-agent-key.ts.
 * Experiment-only – isolated in experiments/ws-bridge.
 *
 * @license Apache-2.0
 */

import type { AgentCredential, AgentPrincipal, TrustLevel } from "../types";

/** In-memory credential store keyed by SHA-256 hex digest of the raw API key. */
const credentials = new Map<string, AgentCredential>();

/**
 * Hashes a raw API key with SHA-256 and returns the hex digest.
 * Agent keys are high-entropy (256 bits), so SHA-256 is appropriate
 * without key-stretching (see ADR-008).
 */
export async function hashApiKey(rawKey: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(rawKey),
	);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Provisions an agent credential with the given trust level.
 * Returns the raw API key (only available at creation time) and the stored credential.
 * Optionally accepts an expiry duration in milliseconds.
 */
export async function provisionAgent(
	name: string,
	trustLevel: TrustLevel,
	expiresInMs?: number,
): Promise<{ rawKey: string; credential: AgentCredential }> {
	const rawKeyBytes = new Uint8Array(32);
	crypto.getRandomValues(rawKeyBytes);
	const rawKey = Array.from(rawKeyBytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	const keyHash = await hashApiKey(rawKey);
	const credential: AgentCredential = {
		id: crypto.randomUUID(),
		name,
		keyHash,
		trustLevel,
		revokedAt: null,
		expiresAt: expiresInMs
			? new Date(Date.now() + expiresInMs).toISOString()
			: null,
	};

	credentials.set(keyHash, credential);
	return { rawKey, credential };
}

/**
 * Verifies a raw API key against the credential store.
 * On match: returns the agent principal. On miss, revoked, or expired: returns null.
 */
export async function verifyAgentKey(
	rawKey: string,
): Promise<AgentPrincipal | null> {
	const keyHash = await hashApiKey(rawKey);
	const cred = credentials.get(keyHash);

	if (!cred || cred.revokedAt !== null) {
		return null;
	}

	if (cred.expiresAt && new Date(cred.expiresAt) <= new Date()) {
		return null;
	}

	return {
		id: cred.id,
		name: cred.name,
		trustLevel: cred.trustLevel,
	};
}

/**
 * Re-validates a credential by agent ID during heartbeat checks.
 * Returns false if the credential is revoked, expired, or missing.
 */
export function checkCredentialValid(agentId: string): boolean {
	for (const cred of credentials.values()) {
		if (cred.id === agentId) {
			if (cred.revokedAt !== null) return false;
			if (cred.expiresAt && new Date(cred.expiresAt) <= new Date())
				return false;
			return true;
		}
	}
	return false;
}

/** Revokes an agent credential by name, setting revoked_at timestamp. */
export function revokeAgent(name: string): boolean {
	for (const cred of credentials.values()) {
		if (cred.name === name && cred.revokedAt === null) {
			cred.revokedAt = new Date().toISOString();
			return true;
		}
	}
	return false;
}

/** Clears all credentials. Test-only. */
export function _clearCredentials(): void {
	credentials.clear();
}
