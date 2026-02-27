/**
 * @file config.ts
 * Hardcoded adaptive challenge defaults. Plugin-only – removable by deleting packages/observability.
 *
 * @license Apache-2.0
 */

/** Resolved adaptive settings with defaults applied. */
export interface ResolvedAdaptiveConfig {
	windowMinutes: number;
	failureThreshold: number;
	highDifficulty: number;
	lowDifficulty: number;
	highThreshold: number;
}

export const adaptiveDefaults: ResolvedAdaptiveConfig = {
	windowMinutes: 15,
	failureThreshold: 3,
	highDifficulty: 5,
	lowDifficulty: 3,
	highThreshold: 6,
};
