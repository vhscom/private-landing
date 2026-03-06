/**
 * @file polyfills.ts
 * Runtime polyfills for APIs available in browsers/Workers but missing in Node.js test environments.
 * Import this file at the top of any test that uses CloseEvent.
 *
 * @license Apache-2.0
 */

// CloseEvent is not available in Node.js but is used by WebSocket close handlers.
// biome-ignore lint/suspicious/noExplicitAny: polyfill assignment to globalThis
(globalThis as any).CloseEvent ??= class CloseEvent extends Event {
	readonly code: number;
	readonly reason: string;
	readonly wasClean: boolean;

	constructor(type: string, init?: CloseEventInit) {
		super(type);
		this.code = init?.code ?? 0;
		this.reason = init?.reason ?? "";
		this.wasClean = init?.wasClean ?? false;
	}
};
