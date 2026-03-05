/**
 * @file upgrade.ts
 * Drop-in replacement for Hono's `upgradeWebSocket` that calls `onOpen`
 * explicitly after `server.accept()`. The stock Cloudflare Workers adapter
 * never fires the open event, so handlers have no ws reference until the
 * first message arrives — making handshake deadlines unenforceable.
 *
 * @see https://github.com/honojs/hono/issues/3448
 * @license Apache-2.0
 */

import type { Context, MiddlewareHandler } from "hono";
import { WSContext, type WSReadyState } from "hono/ws";

/** Subset of Hono WSEvents that handlers must implement. */
export interface WSEvents {
	onOpen?: (evt: Event, ws: WSContext<WebSocket>) => void;
	onMessage?: (evt: MessageEvent, ws: WSContext<WebSocket>) => void;
	onClose?: (evt: CloseEvent, ws: WSContext<WebSocket>) => void;
}

/**
 * Upgrade an HTTP request to a WebSocket connection on Cloudflare Workers.
 * Unlike Hono's built-in helper, this calls `onOpen` after `server.accept()`
 * so the handler receives the ws reference eagerly.
 */
export function upgradeWebSocket(
	createEvents: (c: Context) => WSEvents | Promise<WSEvents>,
	// biome-ignore lint/suspicious/noExplicitAny: matches Hono's UpgradeWebSocket signature
): MiddlewareHandler<any> {
	return async (ctx) => {
		if (ctx.req.header("Upgrade") !== "websocket") {
			return ctx.json({ error: "Expected WebSocket upgrade" }, 426);
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);

		const events = await createEvents(ctx);

		const wsCtx = new WSContext({
			close: (code, reason) => server.close(code, reason),
			get protocol() {
				return server.protocol;
			},
			raw: server,
			get readyState() {
				return server.readyState as WSReadyState;
			},
			url: server.url ? new URL(server.url) : null,
			send: (source) => server.send(source),
		});

		if (events.onMessage) {
			server.addEventListener("message", (evt) =>
				events.onMessage?.(evt as MessageEvent, wsCtx),
			);
		}
		if (events.onClose) {
			server.addEventListener("close", (evt) =>
				events.onClose?.(evt as CloseEvent, wsCtx),
			);
		}

		server.accept();
		events.onOpen?.(new Event("open"), wsCtx);

		return new Response(null, {
			status: 101,
			webSocket: client,
		} as ResponseInit);
	};
}
