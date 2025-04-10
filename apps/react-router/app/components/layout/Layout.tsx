/**
 * @file Layout.tsx
 * Main application layout with navigation and authentication status.
 *
 * @license LGPL-3.0-or-later
 */

import { Link, Outlet, useLocation } from "react-router";
import { useState, type ReactNode } from "react";
import { Button } from "react-aria-components";
import { useAuth } from "../auth/AuthProvider";

/**
 * Navigation link component with active state styling
 */
function NavLink({ to, children }: { to: string; children: ReactNode }) {
	const location = useLocation();
	const isActive = location.pathname === to;

	return (
		<Link
			to={to}
			className={`px-3 py-2 rounded-md text-sm font-medium ${
				isActive
					? "bg-blue-700 text-white"
					: "text-gray-300 hover:bg-blue-600 hover:text-white"
			}`}
			aria-current={isActive ? "page" : undefined}
		>
			{children}
		</Link>
	);
}

/**
 * Main application layout component that wraps all pages
 * This acts as a shell inside the document Layout from root.tsx
 */
export function AppLayout({ children }: { children: ReactNode }) {
	const { isAuthenticated, logout, user } = useAuth();

	return (
		<div className="flex flex-col min-h-screen dark:bg-gray-900 dark:text-white">
			<header className="bg-blue-800 text-white shadow-md">
				<div className="container mx-auto px-4 py-3">
					<div className="flex justify-between items-center">
						<div className="flex items-center">
							<Link to="/" className="text-xl font-bold">
								Private Landing
							</Link>
						</div>

						<div className="flex items-center space-x-4">
							{isAuthenticated ? (
								<div className="flex items-center space-x-2">
									<div className="w-8 h-8 rounded-full bg-gradient-to-r from-secondary to-primary flex items-center justify-center">
										<span className="text-white font-bold">
											{user?.displayName?.charAt(0).toUpperCase() ||
												user?.email.charAt(0).toUpperCase()}
										</span>
									</div>
									<span className="text-white text-sm hidden md:inline">
										{user?.displayName || user?.email}
									</span>
								</div>
							) : (
								<Link
									to="/auth"
									className="bg-white/10 hover:bg-white/20 text-white px-3 py-1.5 rounded-md text-sm transition"
								>
									Sign In
								</Link>
							)}
						</div>

						<div>
							{isAuthenticated && (
								<Button
									onPress={() => logout()}
									className="bg-red-600 hover:bg-red-700 text-white text-sm font-medium px-3 py-2 rounded-md"
								>
									Sign Out
								</Button>
							)}
						</div>
					</div>
				</div>
			</header>

			<main className="flex-grow container mx-auto px-4 py-8">{children}</main>

			<footer className="bg-gray-100 dark:bg-gray-800 py-4 text-center">
				<div className="container mx-auto text-sm text-gray-600 dark:text-gray-400">
					&copy; {new Date().getFullYear()} Private Landing
				</div>
			</footer>
		</div>
	);
}
