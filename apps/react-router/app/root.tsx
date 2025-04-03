/**
 * @file root.tsx
 * Provides layout, error boundaries, and global styles.
 *
 * @license LGPL-3.0-or-later
 */

import {
	type LinksFunction,
	Links,
	Meta,
	Outlet,
	Scripts,
	ScrollRestoration,
} from "react-router";
import type { ReactNode } from "react";
import stylesheet from "./tailwind.css?url";
import { ErrorPage, NotFoundPage } from "./components/error-handling";

export const links: LinksFunction = () => [
	{ rel: "stylesheet", href: stylesheet },
];

/**
 * Main layout component for the application
 */
export function Layout({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
		<head>
			<meta charSet="utf-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1" />
			<Meta />
			<Links />
		</head>
		<body>
		{children}
		<ScrollRestoration />
		<Scripts />
		</body>
		</html>
	);
}

/**
 * Root application component with error boundaries
 */
export default function App() {
	return <Outlet />;
}

/**
 * Error element for handling application errors
 */
export function ErrorBoundary() {
	return (
		<Layout>
			<ErrorPage />
		</Layout>
	);
}

/**
 * Error element for handling 404 not found errors
 */
export function NotFoundBoundary() {
	return (
		<Layout>
			<NotFoundPage />
		</Layout>
	);
}
