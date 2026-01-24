import type { TestProject } from "vitest/node";

export default function ({ provide }: TestProject) {
	// Runs inside Node.js, could start server here...
	provide("port", 1337);
	return () => {
		/* ...then teardown here */
	};
}

declare module "vitest" {
	export interface ProvidedContext {
		port: number;
	}
}
