/**
 * @file AuthProvider.tsx
 * Authentication context provider for managing auth state.
 * Ready to integrate with Private Landing auth system.
 *
 * @license LGPL-3.0-or-later
 */

import {
	createContext,
	useContext,
	useState,
	useEffect,
	type ReactNode,
} from "react";

interface User {
	id: number;
	email: string;
	displayName: string;
}

interface AuthContextType {
	user: User | null;
	isAuthenticated: boolean;
	isLoading: boolean;
	login: (email: string, password: string) => Promise<boolean>;
	logout: () => Promise<void>;
	error: string | null;
}

// Create auth context with default values
const AuthContext = createContext<AuthContextType>({
	user: null,
	isAuthenticated: false,
	isLoading: true,
	login: async () => false,
	logout: async () => {},
	error: null,
});

// Auth provider props
interface AuthProviderProps {
	children: ReactNode;
}

/**
 * Authentication provider component
 * Manages authentication state and provides auth methods
 */
export function AuthProvider({ children }: AuthProviderProps) {
	const [user, setUser] = useState<User | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// Check if user is already authenticated on mount
	useEffect(() => {
		const checkAuthStatus = async () => {
			try {
				// In a real implementation, this would check for valid tokens
				// and retrieve the user profile from the Private Landing auth system

				// For demo purposes, check localStorage
				const savedUser = localStorage.getItem("demoUser");
				if (savedUser) {
					setUser(JSON.parse(savedUser));
				}
			} catch (err) {
				console.error("Auth check failed:", err);
			} finally {
				setIsLoading(false);
			}
		};

		checkAuthStatus();
	}, []);

	/**
	 * Login function - will integrate with Private Landing auth
	 */
	const login = async (email: string, password: string): Promise<boolean> => {
		setIsLoading(true);
		setError(null);

		try {
			// In a real implementation, this would call the auth API
			// For demo purposes, simulate API call
			await new Promise((resolve) => setTimeout(resolve, 1000));

			// Simple validation for demo
			if (!email || !password) {
				setError("Email and password are required");
				return false;
			}

			if (password.length < 8) {
				setError("Password must be at least 8 characters");
				return false;
			}

			// Create demo user
			const demoUser = {
				id: 1,
				email,
				displayName: email.split("@")[0],
			};

			// Store user in state and localStorage for demo
			setUser(demoUser);
			localStorage.setItem("demoUser", JSON.stringify(demoUser));

			return true;
		} catch (err) {
			setError("Authentication failed. Please try again.");
			return false;
		} finally {
			setIsLoading(false);
		}
	};

	/**
	 * Logout function - will integrate with Private Landing auth
	 */
	const logout = async (): Promise<void> => {
		setIsLoading(true);

		try {
			// In a real implementation, this would call the auth API to invalidate tokens
			// For demo purposes, simulate API call
			await new Promise((resolve) => setTimeout(resolve, 500));

			// Clear user state and localStorage
			setUser(null);
			localStorage.removeItem("demoUser");
		} catch (err) {
			console.error("Logout failed:", err);
		} finally {
			setIsLoading(false);
		}
	};

	// Auth context value
	const value = {
		user,
		isAuthenticated: !!user,
		isLoading,
		login,
		logout,
		error,
	};

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Custom hook for using auth context
 */
export function useAuth() {
	return useContext(AuthContext);
}
