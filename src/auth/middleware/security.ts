/**
 * @file security.ts
 * Security headers middleware implementing OWASP Secure Headers Project recommendations.
 * Provides comprehensive protection against common web vulnerabilities through HTTP security headers.
 * @license LGPL-3.0-or-later
 */

import { createMiddleware } from "hono/factory";

/**
 * Security headers middleware implementing OWASP Secure Headers Project recommendations.
 * @see https://owasp.org/www-project-secure-headers/
 *
 * Implements headers to protect against:
 * - Click-jacking attacks (X-Frame-Options)
 * - MIME type sniffing attacks (X-Content-Type-Options)
 * - XSS and code injection (Content-Security-Policy)
 * - Information disclosure (Various headers)
 * - Cross-origin attacks (CORS and isolation policies)
 *
 * Security headers implemented:
 * - Strict-Transport-Security: Forces HTTPS for 1 year including subdomains
 * - X-Frame-Options: Prevents any domain from framing the site
 * - X-Content-Type-Options: Prevents MIME type sniffing
 * - Content-Security-Policy: Strict resource loading rules
 * - X-Permitted-Cross-Domain-Policies: Prevents Flash/PDF from loading data
 * - Referrer-Policy: Maximum privacy for referrer information
 * - Cross-Origin-*-Policy: Browser isolation mechanisms
 * - Permissions-Policy: Restricts browser feature usage
 * - Cache-Control: Prevents sensitive data caching
 *
 * Headers removed:
 * - Server: Hides web server information
 * - X-Powered-By: Hides technology stack information
 * - X-AspNet-Version: Hides .NET framework version
 * - X-AspNetMvc-Version: Hides MVC framework version
 *
 * Note: Some headers may need adjustment based on your application's needs:
 * - CSP if you need to load external resources
 * - Permissions-Policy if you need specific browser features
 * - CORS headers if you have cross-origin requirements
 */
export const securityHeaders = createMiddleware(async (ctx, next) => {
	await next();

	// Create new response with the same body and status
	const res = new Response(ctx.res.body, {
		status: ctx.res.status,
		statusText: ctx.res.statusText,
	});

	// Copy original headers
	ctx.res.headers.forEach((value, key) => {
		res.headers.set(key, value);
	});

	// Add security headers
	res.headers.set(
		"Strict-Transport-Security",
		"max-age=31536000; includeSubDomains",
	);
	res.headers.set("X-Frame-Options", "deny");
	res.headers.set("X-Content-Type-Options", "nosniff");
	res.headers.set(
		"Content-Security-Policy",
		"default-src 'self'; " +
			"script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
			"style-src 'self' 'unsafe-inline'; " +
			"form-action 'self'; " +
			"object-src 'none'; " +
			"frame-ancestors 'none'; " +
			"upgrade-insecure-requests; " +
			"block-all-mixed-content",
	);
	res.headers.set("X-Permitted-Cross-Domain-Policies", "none");
	res.headers.set("Referrer-Policy", "no-referrer");
	res.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
	res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
	res.headers.set("Cross-Origin-Resource-Policy", "same-origin");

	// Permissions policy
	res.headers.set(
		"Permissions-Policy",
		"accelerometer=()," +
			"autoplay=()," +
			"camera=()," +
			"cross-origin-isolated=()," +
			"display-capture=()," +
			"encrypted-media=()," +
			"fullscreen=()," +
			"geolocation=()," +
			"gyroscope=()," +
			"keyboard-map=()," +
			"magnetometer=()," +
			"microphone=()," +
			"midi=()," +
			"payment=()," +
			"picture-in-picture=()," +
			"publickey-credentials-get=()," +
			"screen-wake-lock=()," +
			"sync-xhr=(self)," +
			"usb=()," +
			"web-share=()," +
			"xr-spatial-tracking=()," +
			"clipboard-read=()," +
			"clipboard-write=()," +
			"gamepad=()," +
			"hid=()," +
			"idle-detection=()," +
			"serial=()," +
			"unload=()",
	);

	// Cache Control
	res.headers.set("Cache-Control", "no-store, max-age=0");

	// Remove potentially dangerous headers
	res.headers.delete("Server");
	res.headers.delete("X-Powered-By");
	res.headers.delete("X-AspNet-Version");
	res.headers.delete("X-AspNetMvc-Version");

	ctx.res = res;
});
