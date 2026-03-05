/**
 * @file schemas.ts
 * Zod schemas for WebSocket inbound/outbound messages (ADR-009).
 * Internal to the observability plugin — not exported from packages/schemas.
 *
 * @license Apache-2.0
 */

import { z } from "zod";

export const capabilityEnum = z.enum([
	"query_events",
	"query_sessions",
	"subscribe_events",
	"revoke_session",
]);

export type Capability = z.infer<typeof capabilityEnum>;

export const messageId = z.string().min(1).max(64);

const capabilitiesRequestSchema = z.object({
	type: z.literal("capability.request"),
	capabilities: z.array(z.string().min(1)).nonempty(),
});

const pingSchema = z.object({
	type: z.literal("ping"),
	id: messageId.optional(),
});

const queryEventsSchema = z.object({
	type: z.literal("query_events"),
	id: messageId,
	payload: z
		.object({
			since: z.iso.datetime().optional(),
			event_type: z.string().optional(),
			user_id: z.number().int().positive().optional(),
			ip: z.string().optional(),
			actor_id: z.string().optional(),
			limit: z.number().int().min(1).max(200).optional(),
			offset: z.number().int().min(0).optional(),
			aggregate: z.boolean().optional(),
		})
		.default({}),
});

const querySessionsSchema = z.object({
	type: z.literal("query_sessions"),
	id: messageId,
	payload: z
		.object({
			user_id: z.number().int().positive().optional(),
			active: z.boolean().optional(),
			limit: z.number().int().min(1).max(200).optional(),
			offset: z.number().int().min(0).optional(),
		})
		.default({}),
});

const subscribeEventsSchema = z.object({
	type: z.literal("subscribe_events"),
	id: messageId,
	payload: z
		.object({
			types: z
				.array(
					z
						.string()
						.min(1)
						.regex(/^[a-z_]+(\.\*|\.[a-z_]+)?$/),
				)
				.nonempty()
				.optional(),
		})
		.default({}),
});

const unsubscribeEventsSchema = z.object({
	type: z.literal("unsubscribe_events"),
	id: messageId,
});

const revokeSessionSchema = z.object({
	type: z.literal("revoke_session"),
	id: messageId,
	payload: z.discriminatedUnion("scope", [
		z.object({
			scope: z.literal("user"),
			target_id: z.union([z.number(), z.string()]),
		}),
		z.object({
			scope: z.literal("session"),
			target_id: z.union([z.number(), z.string()]),
		}),
		z.object({
			scope: z.literal("all"),
		}),
	]),
});

export const inboundMessageSchema = z.discriminatedUnion("type", [
	capabilitiesRequestSchema,
	pingSchema,
	queryEventsSchema,
	querySessionsSchema,
	subscribeEventsSchema,
	unsubscribeEventsSchema,
	revokeSessionSchema,
]);

export type InboundMessage = z.infer<typeof inboundMessageSchema>;

/** WebSocket close codes (RFC 6455 private-use range). */
export const CloseCodes = {
	/** Clean shutdown initiated by either side. */
	NORMAL: 1000,
	/** Client did not send capability.request within the deadline. */
	HANDSHAKE_TIMEOUT: 4001,
	/** Malformed JSON or unknown message type. */
	PROTOCOL_ERROR: 4002,
	/** Inbound message rate exceeded per-connection limit. */
	RATE_LIMITED: 4008,
	/** Server is shutting down (e.g. Worker eviction). */
	SERVER_SHUTDOWN: 4009,
	/** Agent credential revoked or expired mid-session. */
	CREDENTIAL_REVOKED: 4010,
	/** Client unresponsive — no messages received within ping timeout. */
	PING_TIMEOUT: 4011,
} as const;
