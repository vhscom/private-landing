import { describe, expect, it } from "vitest";
import { inboundMessageSchema } from "../../src/ws/schemas";

describe("inboundMessageSchema", () => {
	describe("capability.request", () => {
		it("parses a valid capability.request", () => {
			const result = inboundMessageSchema.safeParse({
				type: "capability.request",
				capabilities: ["query_events", "subscribe_events"],
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.type).toBe("capability.request");
			}
		});

		it("rejects empty capabilities array", () => {
			const result = inboundMessageSchema.safeParse({
				type: "capability.request",
				capabilities: [],
			});
			expect(result.success).toBe(false);
		});

		it("accepts unknown capability names (handler denies them gracefully)", () => {
			const result = inboundMessageSchema.safeParse({
				type: "capability.request",
				capabilities: ["not_a_capability"],
			});
			expect(result.success).toBe(true);
		});

		it("rejects missing capabilities field", () => {
			const result = inboundMessageSchema.safeParse({
				type: "capability.request",
			});
			expect(result.success).toBe(false);
		});
	});

	describe("ping", () => {
		it("parses a valid ping", () => {
			const result = inboundMessageSchema.safeParse({
				type: "ping",
				id: "abc-123",
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.type).toBe("ping");
			}
		});

		it("accepts ping without id", () => {
			const result = inboundMessageSchema.safeParse({
				type: "ping",
			});
			expect(result.success).toBe(true);
		});

		it("rejects ping with empty id", () => {
			const result = inboundMessageSchema.safeParse({
				type: "ping",
				id: "",
			});
			expect(result.success).toBe(false);
		});

		it("rejects ping with id exceeding 64 characters", () => {
			const result = inboundMessageSchema.safeParse({
				type: "ping",
				id: "a".repeat(65),
			});
			expect(result.success).toBe(false);
		});
	});

	describe("query_events", () => {
		it("parses with all optional fields", () => {
			const result = inboundMessageSchema.safeParse({
				type: "query_events",
				id: "evt-1",
				payload: {
					since: "2026-03-01T00:00:00Z",
					event_type: "login.success",
					user_id: 42,
					ip: "1.2.3.4",
					actor_id: "agent:monitor",
					limit: 100,
					offset: 10,
				},
			});
			expect(result.success).toBe(true);
		});

		it("parses with empty payload", () => {
			const result = inboundMessageSchema.safeParse({
				type: "query_events",
				id: "evt-2",
				payload: {},
			});
			expect(result.success).toBe(true);
		});

		it("defaults payload to {} when omitted", () => {
			const result = inboundMessageSchema.safeParse({
				type: "query_events",
				id: "evt-3",
			});
			expect(result.success).toBe(true);
		});

		it("rejects limit exceeding 200", () => {
			const result = inboundMessageSchema.safeParse({
				type: "query_events",
				id: "evt-4",
				payload: { limit: 300 },
			});
			expect(result.success).toBe(false);
		});

		it("rejects limit of 0", () => {
			const result = inboundMessageSchema.safeParse({
				type: "query_events",
				id: "evt-5",
				payload: { limit: 0 },
			});
			expect(result.success).toBe(false);
		});

		it("rejects negative offset", () => {
			const result = inboundMessageSchema.safeParse({
				type: "query_events",
				id: "evt-6",
				payload: { offset: -1 },
			});
			expect(result.success).toBe(false);
		});

		it("rejects non-positive user_id", () => {
			const result = inboundMessageSchema.safeParse({
				type: "query_events",
				id: "evt-7",
				payload: { user_id: 0 },
			});
			expect(result.success).toBe(false);
		});

		it("uses event_type not type for filtering", () => {
			const result = inboundMessageSchema.safeParse({
				type: "query_events",
				id: "evt-8",
				payload: { event_type: "login.success" },
			});
			expect(result.success).toBe(true);
			if (result.success && result.data.type === "query_events") {
				expect(result.data.payload.event_type).toBe("login.success");
			}
		});

		it("rejects invalid since datetime", () => {
			const result = inboundMessageSchema.safeParse({
				type: "query_events",
				id: "evt-9",
				payload: { since: "not-a-date" },
			});
			expect(result.success).toBe(false);
		});

		it("parses with aggregate flag", () => {
			const result = inboundMessageSchema.safeParse({
				type: "query_events",
				id: "evt-agg",
				payload: { aggregate: true },
			});
			expect(result.success).toBe(true);
		});
	});

	describe("query_sessions", () => {
		it("parses with all optional fields", () => {
			const result = inboundMessageSchema.safeParse({
				type: "query_sessions",
				id: "sess-1",
				payload: {
					user_id: 5,
					active: false,
					limit: 25,
					offset: 0,
				},
			});
			expect(result.success).toBe(true);
		});

		it("parses with empty payload", () => {
			const result = inboundMessageSchema.safeParse({
				type: "query_sessions",
				id: "sess-2",
				payload: {},
			});
			expect(result.success).toBe(true);
		});

		it("defaults payload to {} when omitted", () => {
			const result = inboundMessageSchema.safeParse({
				type: "query_sessions",
				id: "sess-3",
			});
			expect(result.success).toBe(true);
		});

		it("rejects limit exceeding 200", () => {
			const result = inboundMessageSchema.safeParse({
				type: "query_sessions",
				id: "sess-4",
				payload: { limit: 201 },
			});
			expect(result.success).toBe(false);
		});
	});

	describe("subscribe_events", () => {
		it("parses with type filters", () => {
			const result = inboundMessageSchema.safeParse({
				type: "subscribe_events",
				id: "sub-1",
				payload: { types: ["login.success", "login.failure"] },
			});
			expect(result.success).toBe(true);
		});

		it("parses with empty payload (all types)", () => {
			const result = inboundMessageSchema.safeParse({
				type: "subscribe_events",
				id: "sub-2",
				payload: {},
			});
			expect(result.success).toBe(true);
		});

		it("rejects empty types array", () => {
			const result = inboundMessageSchema.safeParse({
				type: "subscribe_events",
				id: "sub-3",
				payload: { types: [] },
			});
			expect(result.success).toBe(false);
		});

		it("rejects types with empty string", () => {
			const result = inboundMessageSchema.safeParse({
				type: "subscribe_events",
				id: "sub-4",
				payload: { types: [""] },
			});
			expect(result.success).toBe(false);
		});

		it("defaults payload to {} when omitted", () => {
			const result = inboundMessageSchema.safeParse({
				type: "subscribe_events",
				id: "sub-5",
			});
			expect(result.success).toBe(true);
		});

		it("parses wildcard type filter", () => {
			const result = inboundMessageSchema.safeParse({
				type: "subscribe_events",
				id: "sub-wc",
				payload: { types: ["login.*"] },
			});
			expect(result.success).toBe(true);
		});

		it("parses mixed exact and wildcard types", () => {
			const result = inboundMessageSchema.safeParse({
				type: "subscribe_events",
				id: "sub-mix",
				payload: { types: ["password.change", "login.*"] },
			});
			expect(result.success).toBe(true);
		});

		it("rejects invalid wildcard pattern", () => {
			const result = inboundMessageSchema.safeParse({
				type: "subscribe_events",
				id: "sub-bad",
				payload: { types: ["login.**"] },
			});
			expect(result.success).toBe(false);
		});

		it("rejects SQL injection in type filter", () => {
			const result = inboundMessageSchema.safeParse({
				type: "subscribe_events",
				id: "sub-sqli",
				payload: { types: ["'; DROP TABLE--"] },
			});
			expect(result.success).toBe(false);
		});
	});

	describe("unsubscribe_events", () => {
		it("parses a valid unsubscribe_events", () => {
			const result = inboundMessageSchema.safeParse({
				type: "unsubscribe_events",
				id: "unsub-1",
			});
			expect(result.success).toBe(true);
		});

		it("rejects missing id", () => {
			const result = inboundMessageSchema.safeParse({
				type: "unsubscribe_events",
			});
			expect(result.success).toBe(false);
		});
	});

	describe("revoke_session", () => {
		it("parses with user scope and numeric target_id", () => {
			const result = inboundMessageSchema.safeParse({
				type: "revoke_session",
				id: "rev-1",
				payload: { scope: "user", target_id: 42 },
			});
			expect(result.success).toBe(true);
		});

		it("parses with session scope and string target_id", () => {
			const result = inboundMessageSchema.safeParse({
				type: "revoke_session",
				id: "rev-2",
				payload: { scope: "session", target_id: "sess-abc123" },
			});
			expect(result.success).toBe(true);
		});

		it("rejects missing target_id", () => {
			const result = inboundMessageSchema.safeParse({
				type: "revoke_session",
				id: "rev-3",
				payload: { scope: "user" },
			});
			expect(result.success).toBe(false);
		});

		it("rejects missing scope", () => {
			const result = inboundMessageSchema.safeParse({
				type: "revoke_session",
				id: "rev-4",
				payload: { target_id: 1 },
			});
			expect(result.success).toBe(false);
		});

		it("parses with scope all (no target_id)", () => {
			const result = inboundMessageSchema.safeParse({
				type: "revoke_session",
				id: "rev-all",
				payload: { scope: "all" },
			});
			expect(result.success).toBe(true);
		});

		it("rejects invalid scope value", () => {
			const result = inboundMessageSchema.safeParse({
				type: "revoke_session",
				id: "rev-5",
				payload: { scope: "global", target_id: 1 },
			});
			expect(result.success).toBe(false);
		});

		it("rejects missing payload", () => {
			const result = inboundMessageSchema.safeParse({
				type: "revoke_session",
				id: "rev-6",
			});
			expect(result.success).toBe(false);
		});
	});

	describe("unknown types", () => {
		it("rejects unknown message type", () => {
			const result = inboundMessageSchema.safeParse({
				type: "not_a_real_type",
				id: "1",
				payload: {},
			});
			expect(result.success).toBe(false);
		});

		it("rejects completely invalid input", () => {
			const result = inboundMessageSchema.safeParse("not an object");
			expect(result.success).toBe(false);
		});

		it("rejects null input", () => {
			const result = inboundMessageSchema.safeParse(null);
			expect(result.success).toBe(false);
		});
	});
});
