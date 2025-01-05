import type { ResultSet } from "@libsql/client";
import { createDbClient } from "../db.ts";

interface AccountService {
	createAccount: (
		email: string,
		password: string,
		env: Env,
	) => Promise<ResultSet>;
}

export const accountService: AccountService = {
	createAccount: async (email: string, password: string, env: Env) => {
		const { hash, salt } = await hashPassword(password);
		const dbClient = createDbClient(env);
		return dbClient.execute({
			sql: "INSERT INTO accounts (email, password_hash, salt) VALUES (?, ?, ?)",
			args: [email, hash, salt],
		});
	},
};

async function hashPassword(password: string) {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const enc = new TextEncoder().encode(password);
	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		enc,
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const hashBuffer = await crypto.subtle.deriveBits(
		{
			name: "PBKDF2",
			salt,
			iterations: 100000,
			hash: "SHA-256",
		},
		keyMaterial,
		256, // 256 bits
	);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hashBase64 = btoa(String.fromCharCode(...hashArray));
	const saltBase64 = btoa(String.fromCharCode(...salt));
	return { hash: hashBase64, salt: saltBase64 };
}
