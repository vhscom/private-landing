/**
 * @file AuthForm.tsx
 * Combined authentication form for login, registration and logout.
 *
 * @license Apache-2.0
 */

import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "./AuthProvider";

type AuthMode = "signin" | "register";

export function AuthForm() {
	const [mode, setMode] = useState<AuthMode>("signin");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const { isAuthenticated, user, login, logout } = useAuth();
	const navigate = useNavigate();

	// Handle form submission
	const handleSubmit = async (e: FormEvent) => {
		e.preventDefault();
		setError(null);
		setLoading(true);

		try {
			if (mode === "register") {
				// Registration validation
				if (password !== confirmPassword) {
					setError("Passwords don't match");
					setLoading(false);
					return;
				}

				// In real implementation, this would call a registration API
				// For demo, just log in with the same credentials
				await login(email, password);
				navigate("/");
			} else {
				// Sign in
				const success = await login(email, password);
				if (success) {
					navigate("/");
				}
			}
		} catch (err) {
			if (err instanceof Error) {
				setError(err.message);
			} else {
				setError("Authentication failed");
			}
		} finally {
			setLoading(false);
		}
	};

	// Handle logout
	const handleLogout = async () => {
		setLoading(true);
		try {
			await logout();
			navigate("/");
		} catch (err) {
			console.error("Logout failed:", err);
		} finally {
			setLoading(false);
		}
	};

	// If logged in, show logout section
	if (isAuthenticated && user) {
		return (
			<div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6 overflow-hidden border border-gray-200 dark:border-gray-700">
				<div className="mb-4 text-center">
					<div className="inline-block p-3 rounded-full bg-accent/10 mb-3">
						<div className="w-10 h-10 rounded-full bg-gradient-to-r from-secondary to-primary flex items-center justify-center">
							<span className="text-white font-bold text-lg">
								{user.displayName?.charAt(0).toUpperCase() ||
									user.email.charAt(0).toUpperCase()}
							</span>
						</div>
					</div>
					<h2 className="text-xl font-semibold">Welcome Back</h2>
					<p className="text-gray-600 dark:text-gray-400 mt-1">{user.email}</p>
				</div>

				<div className="mt-6">
					<button
						type="button"
						onClick={handleLogout}
						disabled={loading}
						className="w-full py-2 px-4 bg-gradient-to-r from-secondary to-primary text-white font-medium rounded-md hover:opacity-95 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
					>
						{loading ? "Signing out..." : "Sign Out"}
					</button>
				</div>
			</div>
		);
	}

	// Show login/register form
	return (
		<div className="bg-white dark:bg-gray-800 rounded-lg shadow-md overflow-hidden border border-gray-200 dark:border-gray-700">
			{/* Form header with tab selection */}
			<div className="flex border-b border-gray-200 dark:border-gray-700">
				<button
					type="button"
					className={`flex-1 py-3 font-medium ${
						mode === "signin"
							? "text-primary border-b-2 border-primary"
							: "text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
					}`}
					onClick={() => setMode("signin")}
				>
					Sign In
				</button>
				<button
					type="button"
					className={`flex-1 py-3 font-medium ${
						mode === "register"
							? "text-primary border-b-2 border-primary"
							: "text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
					}`}
					onClick={() => setMode("register")}
				>
					Register
				</button>
			</div>

			{/* Form body */}
			<div className="p-6">
				{error && (
					<div className="mb-4 p-3 bg-red-50 dark:bg-red-900/10 text-red-600 dark:text-red-400 rounded-md text-sm">
						{error}
					</div>
				)}

				<form onSubmit={handleSubmit} className="space-y-4">
					<div>
						<label
							htmlFor="email"
							className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
						>
							Email
						</label>
						<input
							id="email"
							type="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							required
							className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent dark:bg-gray-700 dark:text-white"
							placeholder="you@example.com"
						/>
					</div>

					<div>
						<label
							htmlFor="password"
							className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
						>
							Password
						</label>
						<input
							id="password"
							type="password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							required
							className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent dark:bg-gray-700 dark:text-white"
							placeholder={
								mode === "register" ? "Create a password" : "Enter password"
							}
						/>
					</div>

					{mode === "register" && (
						<div>
							<label
								htmlFor="confirmPassword"
								className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
							>
								Confirm Password
							</label>
							<input
								id="confirmPassword"
								type="password"
								value={confirmPassword}
								onChange={(e) => setConfirmPassword(e.target.value)}
								required
								className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent dark:bg-gray-700 dark:text-white"
								placeholder="Confirm password"
							/>
						</div>
					)}

					<div className="mt-6">
						<button
							type="submit"
							disabled={loading}
							className="w-full py-2 px-4 bg-gradient-to-r from-secondary to-primary text-white font-medium rounded-md hover:opacity-95 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
						>
							{loading
								? mode === "register"
									? "Creating Account..."
									: "Signing In..."
								: mode === "register"
									? "Create Account"
									: "Sign In"}
						</button>
					</div>
				</form>

				{mode === "signin" && (
					<div className="mt-4 text-center text-sm text-gray-600 dark:text-gray-400">
						<a href="#" className="text-accent hover:underline">
							Forgot your password?
						</a>
					</div>
				)}
			</div>
		</div>
	);
}
