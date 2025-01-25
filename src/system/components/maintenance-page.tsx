/**
 * @file maintenance-page.tsx
 * Maintenance mode page component with dark mode support and SEO optimization.
 * @license LGPL-3.0-or-later
 */
import type { PageProps } from "../utils/jsx-renderer";

interface MaintenancePageProps extends PageProps {
	message: string;
}

/**
 * Renders the maintenance page with provided message.
 * Includes schema.org markup and responsive styling.
 *
 * @param props - Page properties including maintenance message
 * @returns JSX Element containing the maintenance page HTML
 */
export const MaintenancePage = ({
	title,
	description,
	message,
}: MaintenancePageProps) => {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>{title}</title>
				<meta name="description" content={description} />
				<script type="application/ld+json">
					{{
						"@context": "https://schema.org",
						"@type": "SpecialAnnouncement",
						category: "https://schema.org/DisasterOrEmergencyUpdate",
						text: message,
						announcementLocation: {
							"@type": "Website",
							name: "Private Landing",
							url: "https://example.com", // TODO: Make dynamic
						},
						datePosted: new Date().toISOString(),
					}}
				</script>
				<style>
					{`:root {
                --color-bg: #f5f5f5;
                --color-text: #2c3e50;
              }
              @media (prefers-color-scheme: dark) {
                :root {
                  --color-bg: #1a1a1a;
                  --color-text: #e0e0e0;
                }
              }
              body {
                font-family: system-ui, -apple-system, sans-serif;
                line-height: 1.5;
                background: var(--color-bg);
                color: var(--color-text);
                display: flex;
                align-items: center;
                justify-content: center;
                min-height: 100vh;
                margin: 0;
                padding: 1rem;
              }
              .maintenance-container {
                max-width: 42rem;
                padding: 2rem;
                text-align: center;
                background: color-mix(in srgb, var(--color-bg) 95%, white);
                border-radius: 8px;
                box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);
              }
              h1 {
                font-size: 2rem;
                margin-bottom: 1rem;
              }
              p {
                margin: 0;
                opacity: 0.9;
              }`}
				</style>
			</head>
			<body>
				<div class="maintenance-container">
					<h1>{title}</h1>
					<p>{message}</p>
				</div>
			</body>
		</html>
	);
};
