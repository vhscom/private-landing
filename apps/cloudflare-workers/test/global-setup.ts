import type { GlobalSetupContext } from "vitest/node";

export default function ({ provide }: GlobalSetupContext) {
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
