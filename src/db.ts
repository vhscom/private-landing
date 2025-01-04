import { type Client, createClient } from "@libsql/client/web";

console.log("Hello via db!");

export function createDbClient(env: Env): Client {
	const url = env.TURSO_URL?.trim();
	if (!url) throw new Error("No URL");

	const authToken = env.TURSO_AUTH_TOKEN?.trim();
	if (!authToken) throw new Error("No auth token provided");

	return createClient({ url, authToken });
}
