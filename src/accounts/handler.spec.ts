import { describe, expect, mock, test } from "bun:test";
import type { Context, TypedResponse } from "hono";
import type { RedirectStatusCode } from "hono/utils/http-status";
import { handleLogin, handleRegistration } from "./handler";

type ContextEnv = {
	TURSO_URL: string;
	TURSO_AUTH_TOKEN: string;
};

const createMockTypedResponse = (
	location: string,
	status: RedirectStatusCode = 302,
): Response & TypedResponse<undefined, typeof status, "redirect"> => {
	return {
		...new Response(null, {
			status,
			headers: { Location: location },
		}),
		status,
		redirect: location,
		_data: undefined,
		_status: status,
		_format: "redirect",
	} as Response & TypedResponse<undefined, typeof status, "redirect">;
};

const mockContext = {
	env: {
		TURSO_URL: "libsql://test",
		TURSO_AUTH_TOKEN: "test",
	},
	req: {
		parseBody: async () => ({
			email: "test@example.com",
			password: "password123",
		}),
	} as unknown as Request,
	redirect: (location: string, status: RedirectStatusCode = 302) =>
		createMockTypedResponse(location, status),
	// Required Context properties
	finalized: false,
	error: null,
	event: null,
	executionCtx: null,
	get: () => undefined,
	header: () => undefined,
	match: () => false,
	newResponse: () => new Response(),
	set: () => {},
	update: () => new Response(),
	// Handle other required Context properties
	param: () => "",
	data: {},
	json: () => new Response(),
	text: () => new Response(),
	html: () => new Response(),
	status: () => mockContext,
	res: undefined,
	// Add runtime type information
	runtime: "bun",
} as unknown as Context<{ Bindings: ContextEnv }>;

describe("Handler", () => {
	describe("handleLogin", () => {
		test("redirects with error for invalid credentials", async () => {
			mock.module("./services", () => ({
				accountService: {
					authenticate: async () => ({ authenticated: false }),
				},
			}));

			const response = await handleLogin(mockContext);
			expect(response.headers.get("Location")).toBe(
				"/?error=Invalid email or password",
			);
		});

		test("creates session and redirects on successful login", async () => {
			mock.module("./services", () => ({
				accountService: {
					authenticate: async () => ({ authenticated: true, userId: 1 }),
				},
			}));

			mock.module("./session", () => ({
				createSession: async () => "test-session-id",
			}));

			const response = await handleLogin(mockContext);
			expect(response.headers.get("Location")).toBe("/?authenticated=true");
		});

		test("handles authentication errors gracefully", async () => {
			mock.module("./services", () => ({
				accountService: {
					authenticate: async () => {
						throw new Error("Auth error");
					},
				},
			}));

			const response = await handleLogin(mockContext);
			expect(response.headers.get("Location")).toBe(
				"/?error=Authentication failed. Please try again.",
			);
		});
	});

	describe("handleRegistration", () => {
		test("redirects on successful registration", async () => {
			mock.module("./services", () => ({
				accountService: {
					createAccount: async () => ({ rowsAffected: 1 }),
				},
			}));

			const response = await handleRegistration(mockContext);
			expect(response.headers.get("Location")).toBe("/?registered=true");
		});

		test("handles validation errors", async () => {
			const validationError = new Error("Password too short") as Error & {
				code: string;
				message: string;
			};
			validationError.code = "VALIDATION_ERROR";
			validationError.message = "Password must be at least 8 characters";

			mock.module("./services", () => ({
				accountService: {
					createAccount: async () => {
						throw validationError;
					},
				},
			}));

			const response = await handleRegistration(mockContext);
			expect(response.headers.get("Location")).toBe(
				"/?error=Password must be at least 8 characters",
			);
		});

		test("handles unexpected registration errors", async () => {
			mock.module("./services", () => ({
				accountService: {
					createAccount: async () => {
						throw new Error("Unexpected error");
					},
				},
			}));

			const response = await handleRegistration(mockContext);
			expect(response.headers.get("Location")).toBe(
				"/?error=Registration failed. Please try again.",
			);
		});
	});
});
