// Types
export interface TokenConfig {
	accessTokenExpiry: number; // seconds
	refreshTokenExpiry: number; // seconds
	cookieSecure: boolean;
	cookieSameSite: "Strict" | "Lax" | "None";
}

export interface TokenPayload {
	uid: number; // user_id
	sid: string; // session_id
	typ: "access" | "refresh"; // token type
	exp?: number; // expiration (standard JWT claim)
	[key: string]: string | number | undefined; // Index signature for JWT compatibility
}

// Default configuration
export const tokenConfig: TokenConfig = {
	accessTokenExpiry: 15 * 60, // 15 minutes
	refreshTokenExpiry: 7 * 24 * 3600, // 7 days
	cookieSecure: true,
	cookieSameSite: "Strict",
};
