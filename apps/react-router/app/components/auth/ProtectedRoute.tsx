/**
 * @file ProtectedRoute.tsx
 * Route protection component that redirects unauthenticated users.
 *
 * @license Apache-2.0
 */

import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./AuthProvider";

interface ProtectedRouteProps {
	children: ReactNode;
}

/**
 * Protected route component that redirects to login if not authenticated
 * Stores the attempted URL for redirect back after login
 */
export function ProtectedRoute({ children }: ProtectedRouteProps) {
	const { isAuthenticated, isLoading } = useAuth();
	const location = useLocation();

	// Show loading indicator while checking auth
	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-[50vh]">
				<div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500" />
			</div>
		);
	}

	// Redirect to login if not authenticated, preserving the current location
	if (!isAuthenticated) {
		return <Navigate to="/login" state={{ from: location.pathname }} replace />;
	}

	// Render children if authenticated
	return <>{children}</>;
}
