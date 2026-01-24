/**
 * @file setup.ts
 * Global test setup - runs once before all tests.
 * Handles database migration and seeding for the test environment.
 *
 * @license Apache-2.0
 */

import type { TestProject } from "vitest/node";

export default function ({ provide }: TestProject) {
	provide("port", 1337);

	// Note: Database setup happens in beforeAll hooks within test files
	// because the Worker environment (with env bindings) is only available
	// inside the test isolates, not in this Node.js global setup context.

	return () => {
		// Teardown runs after all tests complete
	};
}

declare module "vitest" {
	export interface ProvidedContext {
		port: number;
	}
}
