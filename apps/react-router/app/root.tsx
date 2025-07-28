/**
 * @file root.tsx
 * Provides layout, error boundaries, and global styles.
 *
 * @license Apache-2.0
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
import { AuthProvider } from "./components/auth/AuthProvider";
import { AppLayout } from "./components/layout/Layout";

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
 * Root application component with auth provider
 */
export default function App() {
	return (
		<AuthProvider>
			<AppLayout>
				<Outlet />
			</AppLayout>
		</AuthProvider>
	);
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
