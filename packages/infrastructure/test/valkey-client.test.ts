/**
 * @file valkey-client.test.ts
 * Unit tests for the Valkey REST protocol client.
 * Spins up a local HTTP server that speaks the Redis REST protocol
 * backed by createMemoryCacheClient, testing real fetch logic.
 *
 * @license Apache-2.0
 */

import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Env } from "@private-landing/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemoryCacheClient } from "../src/cache/memory-client";
import type { CacheClient } from "../src/cache/types";
import { createValkeyClient } from "../src/cache/valkey-client";

const TEST_TOKEN = "test-bearer-token";
let server: ReturnType<typeof createServer>;
let baseUrl: string;
let backing: CacheClient;

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString();
}

async function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const auth = req.headers.authorization;
	if (auth !== `Bearer ${TEST_TOKEN}`) {
		res.writeHead(401, { "Content-Type": "text/plain" });
		res.end("Unauthorized");
		return;
	}

	const body = await readBody(req);
	const args = JSON.parse(body) as (string | number)[];
	const cmd = (args[0] as string).toUpperCase();
	let result: unknown;

	switch (cmd) {
		case "GET":
			result = await backing.get(args[1] as string);
			break;
		case "SET": {
			const ttlIdx = args.indexOf("EX");
			const ttl = ttlIdx !== -1 ? (args[ttlIdx + 1] as number) : undefined;
			await backing.set(args[1] as string, args[2] as string, ttl);
			result = "OK";
			break;
		}
		case "DEL":
			result = await backing.del(...(args.slice(1) as string[]));
			break;
		case "INCR":
			result = await backing.incr(args[1] as string);
			break;
		case "EXPIRE":
			result = (await backing.expire(args[1] as string, args[2] as number))
				? 1
				: 0;
			break;
		case "SADD":
			result = await backing.sadd(
				args[1] as string,
				...(args.slice(2) as string[]),
			);
			break;
		case "SREM":
			result = await backing.srem(
				args[1] as string,
				...(args.slice(2) as string[]),
			);
			break;
		case "SCARD":
			result = await backing.scard(args[1] as string);
			break;
		case "SMEMBERS":
			result = await backing.smembers(args[1] as string);
			break;
		default:
			res.writeHead(400, { "Content-Type": "text/plain" });
			res.end(`Unknown command: ${cmd}`);
			return;
	}

	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ result }));
}

beforeAll(async () => {
	backing = createMemoryCacheClient();

	server = createServer((req, res) => {
		handleRequest(req, res);
	});

	await new Promise<void>((resolve) => {
		server.listen(0, () => resolve());
	});

	const { port } = server.address() as AddressInfo;
	baseUrl = `http://localhost:${port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => {
		server.close(() => resolve());
	});
});

function makeEnv(overrides: Partial<Env> = {}): Env {
	return {
		AUTH_DB_URL: "",
		AUTH_DB_TOKEN: "",
		JWT_ACCESS_SECRET: "",
		JWT_REFRESH_SECRET: "",
		CACHE_URL: baseUrl,
		CACHE_TOKEN: TEST_TOKEN,
		...overrides,
	};
}

describe("createValkeyClient", () => {
	it("should throw when CACHE_URL is missing", () => {
		expect(() => createValkeyClient(makeEnv({ CACHE_URL: undefined }))).toThrow(
			"CACHE_URL environment variable is required",
		);
	});

	describe("string operations", () => {
		it("should get and set values", async () => {
			const client = createValkeyClient(makeEnv());
			await client.set("key", "value");
			expect(await client.get("key")).toBe("value");
		});

		it("should return null for missing keys", async () => {
			const client = createValkeyClient(makeEnv());
			expect(await client.get("nonexistent")).toBeNull();
		});

		it("should set values with TTL", async () => {
			const client = createValkeyClient(makeEnv());
			await client.set("ttl-key", "value", 60);
			expect(await client.get("ttl-key")).toBe("value");
		});
	});

	describe("del", () => {
		it("should delete keys and return count", async () => {
			const client = createValkeyClient(makeEnv());
			await client.set("d1", "v1");
			await client.set("d2", "v2");
			expect(await client.del("d1", "d2")).toBe(2);
			expect(await client.get("d1")).toBeNull();
		});

		it("should return 0 for empty keys", async () => {
			const client = createValkeyClient(makeEnv());
			expect(await client.del()).toBe(0);
		});
	});

	describe("incr", () => {
		it("should increment and return new value", async () => {
			const client = createValkeyClient(makeEnv());
			expect(await client.incr("counter")).toBe(1);
			expect(await client.incr("counter")).toBe(2);
		});
	});

	describe("expire", () => {
		it("should return true for existing keys", async () => {
			const client = createValkeyClient(makeEnv());
			await client.set("exp-key", "value");
			expect(await client.expire("exp-key", 30)).toBe(true);
		});

		it("should return false for missing keys", async () => {
			const client = createValkeyClient(makeEnv());
			expect(await client.expire("no-key", 30)).toBe(false);
		});
	});

	describe("set operations", () => {
		it("should add and list members", async () => {
			const client = createValkeyClient(makeEnv());
			expect(await client.sadd("s", "a", "b")).toBe(2);
			const members = await client.smembers("s");
			expect(members.sort()).toEqual(["a", "b"]);
		});

		it("should return 0 for empty sadd", async () => {
			const client = createValkeyClient(makeEnv());
			expect(await client.sadd("s2")).toBe(0);
		});

		it("should remove members", async () => {
			const client = createValkeyClient(makeEnv());
			await client.sadd("sr", "x", "y", "z");
			expect(await client.srem("sr", "x", "z")).toBe(2);
			expect(await client.smembers("sr")).toEqual(["y"]);
		});

		it("should return 0 for empty srem", async () => {
			const client = createValkeyClient(makeEnv());
			expect(await client.srem("sr2")).toBe(0);
		});

		it("should return cardinality", async () => {
			const client = createValkeyClient(makeEnv());
			await client.sadd("sc", "a", "b", "c");
			expect(await client.scard("sc")).toBe(3);
		});
	});

	describe("authentication", () => {
		it("should fail without correct token", async () => {
			const client = createValkeyClient(makeEnv({ CACHE_TOKEN: "wrong" }));
			await expect(client.get("any")).rejects.toThrow(
				"Cache command failed (401)",
			);
		});

		it("should fail without token", async () => {
			const client = createValkeyClient(makeEnv({ CACHE_TOKEN: undefined }));
			await expect(client.get("any")).rejects.toThrow("401");
		});
	});
});
