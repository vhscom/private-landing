/**
 * @file types.ts
 * Agent identity types for the observability plugin.
 * Plugin-only – removable by deleting packages/observability.
 *
 * @license Apache-2.0
 */

/** Agent trust levels governing operational endpoint access. */
export type TrustLevel = "read" | "write";

/**
 * Runtime representation of an authenticated agent, set on the Hono context.
 * @property id - Database row ID from agent_credential
 * @property name - Unique agent name (alphanumeric + hyphens/underscores)
 * @property trustLevel - Access tier controlling capability grants
 */
export interface AgentPrincipal {
	id: number;
	name: string;
	trustLevel: TrustLevel;
}
