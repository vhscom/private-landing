/**
 * @file maintenance.ts
 * Middleware that checks maintenance mode status and serves maintenance page when enabled.
 * Implements fallback to normal request handling when maintenance mode is disabled.
 * @license LGPL-3.0-or-later
 */

import type { MiddlewareHandler } from "hono";
import { MaintenancePage } from "../components/maintenance-page";
import { getMaintenanceStatus } from "../services/hygraph-service";
import { renderPage } from "../utils/jsx-renderer";

/**
 * Middleware that checks if maintenance mode is enabled.
 * If enabled, serves a maintenance page. Otherwise, continues normal request processing.
 *
 * @param ctx - Hono context containing request and environment
 * @param next - Function to pass control to the next middleware
 * @returns Promise resolving to either maintenance page or next middleware result
 */
export const maintenanceMiddleware: MiddlewareHandler = async (ctx, next) => {
	const maintenance = await getMaintenanceStatus(ctx);
	if (maintenance?.isEnabled) {
		return renderPage(ctx, MaintenancePage, {
			title: "Site Maintenance",
			description:
				"We're currently performing maintenance. Please check back soon.",
			message: maintenance.message,
		});
	}
	return next();
};
