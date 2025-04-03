import { useNavigate } from "react-router-dom";
// import { Search } from "lucide-react";

/**
 * Specialized 404 Not Found page component
 */
export function NotFoundPage() {
	const navigate = useNavigate();

	return (
		<div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col items-center justify-center p-4">
			<div className="max-w-md w-full space-y-8 text-center">
				{/*<Search className="mx-auto h-12 w-12 text-gray-400" />*/}

				<h1 className="mt-6 text-3xl font-bold text-gray-900 dark:text-white">
					404 - Page Not Found
				</h1>

				<p className="mt-2 text-lg text-gray-600 dark:text-gray-400">
					The page you're looking for doesn't exist or has been moved.
				</p>

				<div className="mt-6">
					<button
						type="button"
						onClick={() => navigate("/")}
						className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
					>
						Back to Home
					</button>
				</div>
			</div>
		</div>
	);
}
