/**
 * @file config.ts
 * Hardcoded adaptive challenge defaults. Plugin-only – removable by deleting packages/observability.
 *
 * @license Apache-2.0
 */

/**
 * Resolved adaptive challenge settings with defaults applied.
 * @property windowMinutes - Lookback window for counting failures
 * @property failureThreshold - Failure count that triggers a challenge
 * @property highDifficulty - PoW difficulty when failures exceed highThreshold
 * @property lowDifficulty - PoW difficulty for failures between threshold and highThreshold
 * @property highThreshold - Failure count that escalates to highDifficulty
 */
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
