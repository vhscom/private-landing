/**
 * @file jsx-renderer.tsx
 * Utility functions for rendering full-page JSX components in Hono.
 * @license LGPL-3.0-or-later
 */

import type { Context } from "hono";
import { html } from "hono/html";
import type { Child } from "hono/jsx";

/**
 * Props shared by all full-page components
 */
export interface PageProps {
	title: string;
	description: string;
}

/**
 * Helper to render full JSX pages in Hono context
 *
 * @param ctx - Hono context
 * @param Page - JSX page component to render
 * @param props - Props to pass to the page component
 */
export function renderPage<P extends PageProps>(
	ctx: Context,
	Page: (props: P) => Child,
	props: P,
) {
	return ctx.html(html`<!DOCTYPE html>${Page(props)}`);
}
