/**
 * Mock gateway backend speaking the gateway frame protocol.
 * Handshake: connect.challenge → connect req → hello-ok
 * Frames: {type: "req"} / {type: "res"} / {type: "event"}
 */

import type { ServerWebSocket } from "bun";

const PORT = Number.parseInt(process.env.MOCK_PORT || "18790", 10);

interface SessionState {
	history: Array<{ role: string; content: string; ts: number }>;
	aborted: boolean;
}

interface WsData {
	id: string;
	session: string | null;
	connected: boolean;
}

interface GatewayFrame {
	type: "req" | "res" | "event";
	method?: string;
	event?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: { type: string; message: string };
	id?: string | number;
}

export function createMockBackend(port: number) {
	const sessions = new Map<string, SessionState>();
	const clients = new Set<ServerWebSocket<WsData>>();

	function getSession(name: string): SessionState {
		let s = sessions.get(name);
		if (!s) {
			s = { history: [], aborted: false };
			sessions.set(name, s);
		}
		return s;
	}

	function broadcast(event: string, params: Record<string, unknown>): void {
		const msg = JSON.stringify({ type: "event", event, params });
		for (const ws of clients) {
			if (!ws.data.connected) continue;
			try {
				ws.send(msg);
			} catch {
				// Ignore send failures
			}
		}
	}

	function sendRes(
		ws: ServerWebSocket<WsData>,
		id: string | number | undefined,
		result: unknown,
	): void {
		ws.send(JSON.stringify({ type: "res", id, result }));
	}

	function sendResError(
		ws: ServerWebSocket<WsData>,
		id: string | number | undefined,
		errorType: string,
		message: string,
	): void {
		ws.send(
			JSON.stringify({ type: "res", id, error: { type: errorType, message } }),
		);
	}

	function handleReq(ws: ServerWebSocket<WsData>, frame: GatewayFrame): void {
		const { method, params, id } = frame;

		// Connect handshake
		if (method === "connect") {
			ws.data.connected = true;
			ws.send(
				JSON.stringify({
					type: "res",
					id,
					result: { type: "hello-ok" },
				}),
			);
			return;
		}

		// Acknowledge ko-olleh
		if (method === "ko-olleh") {
			sendRes(ws, id, { ack: true });
			return;
		}

		// Reject pre-handshake requests
		if (!ws.data.connected) {
			sendResError(ws, id, "protocol_error", "Not connected");
			return;
		}

		const sessionName =
			(params?.session as string) ?? ws.data.session ?? "default";
		ws.data.session = sessionName;
		const session = getSession(sessionName);

		switch (method) {
			case "chat.history": {
				sendRes(ws, id, { history: session.history });
				break;
			}
			case "chat.send": {
				const content = (params?.content as string) ?? "";
				session.aborted = false;
				session.history.push({ role: "user", content, ts: Date.now() });

				const reply = `Echo: ${content}`;
				session.history.push({
					role: "assistant",
					content: reply,
					ts: Date.now(),
				});

				sendRes(ws, id, { content: reply });
				broadcast("chat.message", {
					session: sessionName,
					role: "assistant",
					content: reply,
				});
				break;
			}
			case "chat.abort": {
				session.aborted = true;
				sendRes(ws, id, { aborted: true });
				break;
			}
			case "chat.inject": {
				const role = (params?.role as string) ?? "system";
				const content = (params?.content as string) ?? "";
				session.history.push({ role, content, ts: Date.now() });
				sendRes(ws, id, { injected: true });
				break;
			}
			default:
				sendResError(ws, id, "unknown_method", `Unknown method: ${method}`);
		}
	}

	const server = Bun.serve<WsData>({
		port,
		fetch(req, server) {
			const upgraded = server.upgrade(req, {
				data: { id: crypto.randomUUID(), session: null, connected: false },
			});
			if (upgraded) return undefined;
			return new Response("WebSocket only", { status: 426 });
		},
		websocket: {
			open(ws) {
				clients.add(ws);
				console.log(
					JSON.stringify({
						ts: new Date().toISOString(),
						event: "mock.client_connected",
						id: ws.data.id,
					}),
				);

				// Send connect.challenge
				ws.send(
					JSON.stringify({
						type: "event",
						event: "connect.challenge",
						params: { nonce: crypto.randomUUID() },
					}),
				);
			},
			message(ws, raw) {
				try {
					const frame = JSON.parse(String(raw)) as GatewayFrame;
					if (frame.type === "req") {
						handleReq(ws, frame);
					} else {
						sendResError(
							ws,
							undefined,
							"protocol_error",
							`Unexpected frame type: ${frame.type}`,
						);
					}
				} catch {
					ws.send(
						JSON.stringify({
							type: "res",
							error: { type: "parse_error", message: "Invalid JSON" },
						}),
					);
				}
			},
			close(ws) {
				clients.delete(ws);
				console.log(
					JSON.stringify({
						ts: new Date().toISOString(),
						event: "mock.client_disconnected",
						id: ws.data.id,
					}),
				);
			},
		},
	});

	const healthInterval = setInterval(() => {
		broadcast("health.ping", {
			uptime: process.uptime(),
			clients: clients.size,
		});
	}, 10_000);

	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			event: "mock.start",
			port,
		}),
	);

	return {
		server,
		stop() {
			clearInterval(healthInterval);
			server.stop(true);
		},
	};
}

// Run when executed directly
if (import.meta.main) {
	createMockBackend(PORT);
}
