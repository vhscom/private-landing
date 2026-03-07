/**
 * Mock OpenClaw WebSocket backend.
 * Handles JSON-RPC style messages and broadcasts events.
 * Listens on ws://localhost:18790
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
}

interface RpcMessage {
	method?: string;
	params?: Record<string, unknown>;
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

	function broadcast(event: string, data: Record<string, unknown>): void {
		const msg = JSON.stringify({ event, ...data });
		for (const ws of clients) {
			try {
				ws.send(msg);
			} catch {
				// Ignore send failures
			}
		}
	}

	function handleRpc(ws: ServerWebSocket<WsData>, msg: RpcMessage): void {
		const { method, params, id } = msg;
		const sessionName =
			(params?.session as string) ?? ws.data.session ?? "default";
		ws.data.session = sessionName;
		const session = getSession(sessionName);

		switch (method) {
			case "chat.history": {
				ws.send(JSON.stringify({ id, result: { history: session.history } }));
				break;
			}
			case "chat.send": {
				const content = (params?.content as string) ?? "";
				session.aborted = false;
				session.history.push({ role: "user", content, ts: Date.now() });

				// Simulate assistant response
				const reply = `Echo: ${content}`;
				session.history.push({
					role: "assistant",
					content: reply,
					ts: Date.now(),
				});

				ws.send(JSON.stringify({ id, result: { content: reply } }));
				broadcast("chat.message", {
					params: { session: sessionName, role: "assistant", content: reply },
				});
				break;
			}
			case "chat.abort": {
				session.aborted = true;
				ws.send(JSON.stringify({ id, result: { aborted: true } }));
				break;
			}
			case "chat.inject": {
				const role = (params?.role as string) ?? "system";
				const content = (params?.content as string) ?? "";
				session.history.push({ role, content, ts: Date.now() });
				ws.send(JSON.stringify({ id, result: { injected: true } }));
				break;
			}
			default:
				ws.send(
					JSON.stringify({
						id,
						error: {
							type: "unknown_method",
							message: `Unknown method: ${method}`,
						},
					}),
				);
		}
	}

	const server = Bun.serve<WsData>({
		port,
		fetch(req, server) {
			const upgraded = server.upgrade(req, {
				data: { id: crypto.randomUUID(), session: null },
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
			},
			message(ws, raw) {
				try {
					const msg = JSON.parse(String(raw)) as RpcMessage;
					handleRpc(ws, msg);
				} catch {
					ws.send(
						JSON.stringify({
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

	// Periodic health broadcast every 10s
	const healthInterval = setInterval(() => {
		broadcast("health.ping", {
			params: { uptime: process.uptime(), clients: clients.size },
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
