import { useRouteError } from 'react-router-dom';
import { isRouteErrorResponse } from './types';

/**
 * Interface for the error details extracted by the hook
 */
interface ErrorDetails {
  /** The HTTP status code (for route errors) or 500 for JS errors */
  status: number;
  /** User-friendly error title */
  title: string;
  /** Detailed error message */
  message: string;
  /** Technical details (stack trace, etc.) for development purposes */
  details: string | null;
  /** Whether this is a 404 Not Found error */
  isNotFound: boolean;
}

/**
 * Hook to handle and extract information from route errors
 *
 * @returns Normalized error details
 */
export function useErrorHandler(): ErrorDetails {
  const error = useRouteError();

  // Default error details
  const defaultDetails: ErrorDetails = {
    status: 500,
    title: 'Application Error',
    message: 'An unexpected error occurred.',
    details: null,
    isNotFound: false
  };

  // Handle route error responses (from React Router)
  if (isRouteErrorResponse(error)) {
    return {
      status: error.status,
      title: error.statusText || 'Error',
      message: error.data?.message || `${error.status} ${error.statusText}`,
      details: JSON.stringify(error.data, null, 2),
      isNotFound: error.status === 404
    };
  }

  // Handle standard JavaScript errors
  if (error instanceof Error) {
    return {
      ...defaultDetails,
      message: error.message || 'An unexpected error occurred.',
      details: error.stack || null
    };
  }

  // Handle string errors
  if (typeof error === 'string') {
    return {
      ...defaultDetails,
      message: error
    };
  }

  // Fall back to default error details for unknown error types
  return defaultDetails;
}