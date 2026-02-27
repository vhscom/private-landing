/**
 * @file config.test.ts
 * Unit tests for adaptive challenge defaults.
 *
 * @license Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { adaptiveDefaults } from "../src/config";

describe("adaptiveDefaults", () => {
	it("has expected window of 15 minutes", () => {
		expect(adaptiveDefaults.windowMinutes).toBe(15);
	});

	it("has failure threshold of 3", () => {
		expect(adaptiveDefaults.failureThreshold).toBe(3);
	});

	it("has high difficulty of 5", () => {
		expect(adaptiveDefaults.highDifficulty).toBe(5);
	});

	it("has low difficulty of 3", () => {
		expect(adaptiveDefaults.lowDifficulty).toBe(3);
	});

	it("has high threshold of 6", () => {
		expect(adaptiveDefaults.highThreshold).toBe(6);
	});
});
