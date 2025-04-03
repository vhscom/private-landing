import { useNavigate } from "react-router-dom";
import { useErrorHandler } from "./use-error-handler";
// import { AlertTriangle } from "lucide-react";
import { useState } from "react";

/**
 * Generic error page component for displaying errors caught by React Router
 */
export function ErrorPage() {
	const navigate = useNavigate();
	const { status, title, message, details } = useErrorHandler();
	const [showDetails, setShowDetails] = useState(false);

	const isDev = import.meta.env.DEV;

	return (
		<div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col items-center justify-center p-4">
			<div className="max-w-md w-full space-y-8 text-center">
				{/*<AlertTriangle className="mx-auto h-12 w-12 text-yellow-500" />*/}

				<h1 className="mt-6 text-3xl font-bold text-gray-900 dark:text-white">
					{status} - {title}
				</h1>

				<p className="mt-2 text-lg text-gray-600 dark:text-gray-400">
					{message}
				</p>

				<div className="mt-6 space-x-4">
					<button
						type="button"
						onClick={() => {
							if (window.location.pathname === "/") {
								window.location.reload();
							} else {
								navigate("/");
							}
						}}
						className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
					>
						Back to Home
					</button>

					{isDev && details && (
						<button
							type="button"
							onClick={() => setShowDetails(!showDetails)}
							className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
						>
							{showDetails ? "Hide" : "Show"} Details
						</button>
					)}
				</div>

				{isDev && showDetails && details && (
					<div className="mt-6 text-left">
						<h2 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
							Error Details
						</h2>
						<pre className="p-4 bg-gray-100 dark:bg-gray-900 rounded-md overflow-auto text-sm text-gray-800 dark:text-gray-200 max-h-96">
							{details}
						</pre>
					</div>
				)}
			</div>
		</div>
	);
}
