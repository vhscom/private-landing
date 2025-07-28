/**
 * @file entry.server.tsx
 * React Router server entrypoint.
 *
 * @license Apache-2.0
 */

import {
	ServerRouter,
	type AppLoadContext,
	type EntryContext,
} from 'react-router';
import { isbot } from 'isbot';
import { renderToReadableStream } from 'react-dom/server';

export default async function handleRequest(
	request: Request,
	responseStatusCode: number,
	responseHeaders: Headers,
	remixContext: EntryContext,
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	loadContext: AppLoadContext,
) {
	let status = responseStatusCode;

	const body = await renderToReadableStream(
		<ServerRouter context={remixContext} url={request.url} />,
		{
			signal: request.signal,
			onError(error: unknown) {
				console.error(error);
				status = 500;
			},
		},
	);

	if (isbot(request.headers.get('user-agent') || '')) {
		await body.allReady;
	}

	responseHeaders.set('Content-Type', 'text/html');
	return new Response(body, {
		headers: responseHeaders,
		status,
	});
}
