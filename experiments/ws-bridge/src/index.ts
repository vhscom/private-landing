/**
 * @file index.ts
 * Bridge server entry point. Hono handles /health, Bun.serve handles WebSocket
 * upgrade on /ops with agent-key auth before connection is established.
 * Experiment-only – isolated in experiments/ws-bridge.
 *
 * @license Apache-2.0
 */

import type { ServerWebSocket } from "bun";
import { Hono } from "hono";
import { BridgeRelay } from "./bridge/relay";
import { verifyAgentKey } from "./middleware/auth";
import { MAX_MESSAGE_BYTES, type WsData } from "./types";

const PORT = Number.parseInt(process.env.PORT || "18800", 10);
const BACKEND_URL = process.env.BACKEND_URL || "ws://localhost:18790";

const app = new Hono();

app.get("/health", (c) => c.json({ status: "ok", version: "2.0.0-exp" }));

/** Creates the bridge server with agent auth on /ops and health check on /health. */
export function createServer(port: number, backendUrl?: string) {
	const relay = new BridgeRelay(backendUrl ?? BACKEND_URL);

	const server = Bun.serve<WsData>({
		port,
		async fetch(req, server) {
			const url = new URL(req.url);

			if (url.pathname === "/ops") {
				const authHeader = req.headers.get("authorization");
				if (!authHeader?.startsWith("Bearer ")) {
					return new Response(
						JSON.stringify({
							error: { type: "unauthorized", message: "Missing Bearer token" },
						}),
						{ status: 401, headers: { "content-type": "application/json" } },
					);
				}

				const rawKey = authHeader.slice(7);
				const agent = await verifyAgentKey(rawKey);
				if (!agent) {
					return new Response(
						JSON.stringify({
							error: { type: "unauthorized", message: "Invalid agent key" },
						}),
						{ status: 401, headers: { "content-type": "application/json" } },
					);
				}

				const upgraded = server.upgrade(req, {
					data: { connId: "", agent },
				});
				if (upgraded) return undefined;
				return new Response("WebSocket upgrade failed", { status: 500 });
			}

			return app.fetch(req);
		},
		websocket: {
			maxPayloadLength: MAX_MESSAGE_BYTES,
			open(ws: ServerWebSocket<WsData>) {
				const { agent } = ws.data;
				if (!agent) {
					ws.close(4000, "Missing auth context");
					return;
				}
				relay.handleOpen(ws, agent);
			},
			message(ws: ServerWebSocket<WsData>, msg) {
				relay.handleMessage(ws, String(msg));
			},
			close(ws: ServerWebSocket<WsData>) {
				relay.handleClose(ws);
			},
		},
	});

	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			event: "server.start",
			port,
			backendUrl: backendUrl ?? BACKEND_URL,
		}),
	);

	return { server, relay };
}

// Run when executed directly
if (import.meta.main) {
	createServer(PORT);
}
