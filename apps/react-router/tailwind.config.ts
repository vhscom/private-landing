import type { Config } from "tailwindcss";

export default {
	content: ["./app/**/{**,.client,.server}/**/*.{js,jsx,ts,tsx}"],
	theme: {
		extend: {
			colors: {
				primary: "#4717f6", // Blue
				secondary: "#a239ca", // Purple
				accent: "#30bced", // Cyan
				highlight: "#ff7700", // Orange
				dark: "#0e0b16", // Dark background
			},
			fontFamily: {
				sans: [
					"Inter",
					"ui-sans-serif",
					"system-ui",
					"sans-serif",
					"Apple Color Emoji",
					"Segoe UI Emoji",
					"Segoe UI Symbol",
					"Noto Color Emoji",
				],
			},
		},
	},
	plugins: [],
} satisfies Config;
