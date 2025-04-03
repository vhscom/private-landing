/**
 * Type definitions for the error handling system
 */

/**
 * Represents a route error response in React Router v7
 */
export interface RouteErrorResponse {
  status: number;
  statusText: string;
  data: {
    message?: string;
    [key: string]: any;
  };
}

/**
 * Type guard to check if an error is a RouteErrorResponse
 * @param error - The error to check
 * @returns True if the error is a RouteErrorResponse
 */
export function isRouteErrorResponse(error: any): error is RouteErrorResponse {
  return (
    error != null &&
    typeof error === 'object' &&
    'status' in error &&
    'statusText' in error &&
    'data' in error
  );
}