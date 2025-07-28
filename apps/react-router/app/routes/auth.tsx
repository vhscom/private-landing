/**
 * @file routes/auth.tsx
 * Authentication page with combined sign-in/register form.
 *
 * @license Apache-2.0
 */

import { AuthForm } from "~/components/auth/AuthForm";

export const meta = () => {
	return [
		{ title: "Authentication - Private Landing" },
		{ name: "description", content: "Sign in or create an account" },
	];
};

export default function Auth() {
	return (
		<div className="max-w-md mx-auto py-12">
			<h1 className="text-3xl font-bold text-center mb-8">
				<span className="bg-clip-text text-transparent bg-gradient-to-r from-secondary to-primary">
					Welcome Back
				</span>
			</h1>

			<AuthForm />

			<div className="mt-8 text-center text-sm text-gray-600 dark:text-gray-400">
				<p>
					This is a demo authentication system.
					<br />
					It will be integrated with Private Landing's secure auth system.
				</p>
			</div>
		</div>
	);
}
