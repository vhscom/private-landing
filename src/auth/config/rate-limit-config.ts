/**
 * Configuration for an individual rate limit rule.
 * @property windowSeconds - Time window for rate limiting in seconds
 * @property maxAttempts - Maximum attempts allowed within window
 * @property keyPrefix - KV store prefix for this rate limit
 */
export interface RateLimitRule {
	windowSeconds: number;
	maxAttempts: number;
	keyPrefix: string;
}

/**
 * Configuration for rate limiting across different actions.
 * @property login - Login attempt limits
 * @property refresh - Token refresh limits
 * @property reset - Password reset limits
 */
export interface RateLimitConfig {
	login: RateLimitRule;
	refresh: RateLimitRule;
	reset: RateLimitRule;
}

// Default configuration
export const rateLimitConfig: RateLimitConfig = {
	login: {
		windowSeconds: 5 * 60, // 5 minutes
		maxAttempts: 5,
		keyPrefix: "rl:login",
	},
	refresh: {
		windowSeconds: 60 * 60, // 1 hour
		maxAttempts: 10,
		keyPrefix: "rl:refresh",
	},
	reset: {
		windowSeconds: 60 * 60, // 1 hour
		maxAttempts: 3,
		keyPrefix: "rl:reset",
	},
};

/**
 * Creates rate limit configuration with custom overrides.
 * @param action - The rate limit action to configure
 * @param overrides - Partial configuration to override defaults
 * @returns Complete rate limit configuration for the action
 */
export function createRateLimitRule(
	action: keyof RateLimitConfig,
	overrides?: Partial<RateLimitRule>,
): RateLimitRule {
	return {
		...rateLimitConfig[action],
		...overrides,
	};
}
