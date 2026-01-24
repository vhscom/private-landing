/**
 * @file crypto.test.ts
 * Unit tests for cryptographic utilities.
 *
 * @license Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { timingSafeEqual } from "../src/auth/utils/crypto";

describe("timingSafeEqual", () => {
	describe("equal values", () => {
		it("should return true for equal ArrayBuffers", async () => {
			const a = new TextEncoder().encode("hello world");
			const b = new TextEncoder().encode("hello world");

			const result = await timingSafeEqual(a, b);
			expect(result).toBe(true);
		});

		it("should return true for equal Uint8Arrays", async () => {
			const a = new Uint8Array([1, 2, 3, 4, 5]);
			const b = new Uint8Array([1, 2, 3, 4, 5]);

			const result = await timingSafeEqual(a, b);
			expect(result).toBe(true);
		});

		it("should return true for empty buffers", async () => {
			const a = new Uint8Array([]);
			const b = new Uint8Array([]);

			const result = await timingSafeEqual(a, b);
			expect(result).toBe(true);
		});

		it("should return true for single byte buffers", async () => {
			const a = new Uint8Array([42]);
			const b = new Uint8Array([42]);

			const result = await timingSafeEqual(a, b);
			expect(result).toBe(true);
		});

		it("should return true for large equal buffers", async () => {
			const size = 10000;
			const a = new Uint8Array(size).fill(0xab);
			const b = new Uint8Array(size).fill(0xab);

			const result = await timingSafeEqual(a, b);
			expect(result).toBe(true);
		});
	});

	describe("unequal values", () => {
		it("should return false for different content", async () => {
			const a = new TextEncoder().encode("hello");
			const b = new TextEncoder().encode("world");

			const result = await timingSafeEqual(a, b);
			expect(result).toBe(false);
		});

		it("should return false for single byte difference", async () => {
			const a = new Uint8Array([1, 2, 3, 4, 5]);
			const b = new Uint8Array([1, 2, 3, 4, 6]);

			const result = await timingSafeEqual(a, b);
			expect(result).toBe(false);
		});

		it("should return false for first byte difference", async () => {
			const a = new Uint8Array([1, 2, 3, 4, 5]);
			const b = new Uint8Array([0, 2, 3, 4, 5]);

			const result = await timingSafeEqual(a, b);
			expect(result).toBe(false);
		});

		it("should return false for middle byte difference", async () => {
			const a = new Uint8Array([1, 2, 3, 4, 5]);
			const b = new Uint8Array([1, 2, 0, 4, 5]);

			const result = await timingSafeEqual(a, b);
			expect(result).toBe(false);
		});
	});

	describe("length mismatches", () => {
		it("should return false for different lengths", async () => {
			const a = new Uint8Array([1, 2, 3]);
			const b = new Uint8Array([1, 2, 3, 4]);

			const result = await timingSafeEqual(a, b);
			expect(result).toBe(false);
		});

		it("should return false when first is longer", async () => {
			const a = new TextEncoder().encode("hello world");
			const b = new TextEncoder().encode("hello");

			const result = await timingSafeEqual(a, b);
			expect(result).toBe(false);
		});

		it("should return false when second is longer", async () => {
			const a = new TextEncoder().encode("hello");
			const b = new TextEncoder().encode("hello world");

			const result = await timingSafeEqual(a, b);
			expect(result).toBe(false);
		});

		it("should return false for empty vs non-empty", async () => {
			const a = new Uint8Array([]);
			const b = new Uint8Array([1]);

			const result = await timingSafeEqual(a, b);
			expect(result).toBe(false);
		});
	});

	describe("buffer type handling", () => {
		it("should handle ArrayBuffer directly", async () => {
			const a = new Uint8Array([1, 2, 3]).buffer;
			const b = new Uint8Array([1, 2, 3]).buffer;

			const result = await timingSafeEqual(a, b);
			expect(result).toBe(true);
		});

		it("should handle mixed buffer types", async () => {
			const a = new Uint8Array([1, 2, 3]);
			const b = new Uint8Array([1, 2, 3]).buffer;

			const result = await timingSafeEqual(a, b);
			expect(result).toBe(true);
		});

		it("should handle DataView", async () => {
			const buffer1 = new ArrayBuffer(3);
			const buffer2 = new ArrayBuffer(3);
			const view1 = new DataView(buffer1);
			const view2 = new DataView(buffer2);

			view1.setUint8(0, 1);
			view1.setUint8(1, 2);
			view1.setUint8(2, 3);
			view2.setUint8(0, 1);
			view2.setUint8(1, 2);
			view2.setUint8(2, 3);

			const result = await timingSafeEqual(view1, view2);
			expect(result).toBe(true);
		});
	});

	describe("binary data", () => {
		it("should handle all byte values", async () => {
			// Create buffers with all possible byte values
			const a = new Uint8Array(256);
			const b = new Uint8Array(256);
			for (let i = 0; i < 256; i++) {
				a[i] = i;
				b[i] = i;
			}

			const result = await timingSafeEqual(a, b);
			expect(result).toBe(true);
		});

		it("should detect difference in high byte values", async () => {
			const a = new Uint8Array([0xff, 0xfe, 0xfd]);
			const b = new Uint8Array([0xff, 0xfe, 0xfc]);

			const result = await timingSafeEqual(a, b);
			expect(result).toBe(false);
		});

		it("should handle null bytes", async () => {
			const a = new Uint8Array([0, 0, 0, 0]);
			const b = new Uint8Array([0, 0, 0, 0]);

			const result = await timingSafeEqual(a, b);
			expect(result).toBe(true);
		});
	});
});
