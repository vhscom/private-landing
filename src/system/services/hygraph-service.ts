/**
 * @file hygraph-service.ts
 * Service for interacting with Hygraph CMS.
 * Handles maintenance mode status checks through GraphQL API.
 * @license LGPL-3.0-or-later
 */

import type { Context } from "hono";

/**
 * Configuration for site maintenance mode.
 * Retrieved from Hygraph CMS.
 */
interface MaintenanceConfig {
	isEnabled: boolean;
	message: string;
}

/**
 * GraphQL response structure from Hygraph API.
 * Wraps maintenance configuration in data property.
 */
interface HygraphResponse {
	data: {
		maintenanceConfig: MaintenanceConfig[];
	};
}

/**
 * Fetches the current maintenance mode status from Hygraph CMS.
 * Returns the maintenance configuration if enabled, or null if disabled/error.
 *
 * @param ctx - Hono context containing request and environment
 * @returns Promise resolving to maintenance config or null
 * @throws {TypeError} When response cannot be parsed as JSON
 * @throws {Error} When fetch fails or network error occurs
 */
export async function getMaintenanceStatus(
	ctx: Context,
): Promise<MaintenanceConfig | null> {
	const endpoint = ctx.env.HYGRAPH_ENDPOINT;

	const response = await fetch(endpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({
			query: `
				query MaintenanceMode {
					maintenanceConfig(where: { id: "cm6cjacki4bka07mvwa06gwwu" }) {
						isEnabled
						message
					}
				}
			`,
		}),
	});

	if (!response.ok) return null;

	const responseData = await response.json();

	if (responseData?.data?.maintenanceConfig) {
		return responseData.data.maintenanceConfig;
	}

	return null;
}
