import type { AgentCredential, AgentPrincipal, TrustLevel } from "../types";

/**
 * In-memory credential store.
 * Prototype substitute for the agent_credential table in production.
 * Keys are SHA-256 hex digests of the raw API key.
 */
const credentials = new Map<string, AgentCredential>();

/**
 * Hash a raw API key with SHA-256 and return the hex digest.
 * Matches the pattern in packages/observability/src/require-agent-key.ts.
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
 * Provision an agent credential and return the raw API key.
 * The raw key is only available at creation time (never stored).
 */
export async function provisionAgent(
	name: string,
	trustLevel: TrustLevel,
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
	};

	credentials.set(keyHash, credential);
	return { rawKey, credential };
}

/**
 * Verify a raw API key against the credential store.
 * Returns the agent principal on success, null on failure.
 */
export async function verifyAgentKey(
	rawKey: string,
): Promise<AgentPrincipal | null> {
	const keyHash = await hashApiKey(rawKey);
	const cred = credentials.get(keyHash);

	if (!cred || cred.revokedAt !== null) {
		return null;
	}

	return {
		id: cred.id,
		name: cred.name,
		trustLevel: cred.trustLevel,
	};
}

/** Revoke an agent credential by name. */
export function revokeAgent(name: string): boolean {
	for (const cred of credentials.values()) {
		if (cred.name === name && cred.revokedAt === null) {
			cred.revokedAt = new Date().toISOString();
			return true;
		}
	}
	return false;
}

/** Clear all credentials (for testing). */
export function clearCredentials(): void {
	credentials.clear();
}
