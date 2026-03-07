/**
 * @file schemas.ts
 * Zod schemas for control bridge inbound messages (ADR-010).
 * Plugin-only – removable with packages/control.
 *
 * @license Apache-2.0
 */

import { z } from "zod";

const messageId = z.string().min(1).max(64);

const negotiateSchema = z.object({
	type: z.literal("negotiate"),
	solution: z.string().min(1).max(256),
	capabilities: z.array(z.string().min(1)).nonempty(),
});

const relaySchema = z.object({
	type: z.literal("relay"),
	method: z.string().min(1).optional(),
	event: z.string().min(1).optional(),
	params: z.record(z.string(), z.unknown()).optional(),
	id: messageId.optional(),
});

const pingSchema = z.object({
	type: z.literal("ping"),
	id: messageId.optional(),
});

export const inboundMessageSchema = z.discriminatedUnion("type", [
	negotiateSchema,
	relaySchema,
	pingSchema,
]);

export type InboundMessage = z.infer<typeof inboundMessageSchema>;
