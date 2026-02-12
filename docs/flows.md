# Authentication Flow Diagrams

Sequence diagrams for every authentication flow in Private Landing. Each diagram maps directly to source code in `packages/core/`.

> **Rendering:** GitHub renders Mermaid natively. For local preview, use the [Mermaid Live Editor](https://mermaid.live) or a VS Code extension.

---

## 1. Registration

User creates a new account. The password is hashed with PBKDF2-SHA384 before storage.

```mermaid
sequenceDiagram
  participant U as User Agent
  participant H as Hono Worker
  participant AS as AccountService
  participant PS as PasswordService
  participant DB as Turso DB

  U->>H: POST /api/register {email, password}
  H->>AS: createAccount(input, env)

  AS->>AS: registrationSchema.safeParseAsync(input)
  Note over AS: Zod validates email format<br/>and password length (NIST SP 800-63B)

  alt Validation fails
    AS-->>H: throw ValidationError
    H-->>U: 400 {error, code: "VALIDATION_ERROR"}
  end

  AS->>PS: hashPassword(password)
  Note over PS: 1. Generate 16-byte random salt<br/>2. PBKDF2 deriveBits (100k iterations, SHA-384)<br/>3. SHA-384 integrity digest<br/>4. Base64-encode salt, hash, digest
  PS-->>AS: "$pbkdf2-sha384$v1$100000$salt$hash$digest"

  AS->>DB: INSERT INTO account (email, password_data) VALUES (?, ?)
  Note over AS,DB: Parameterized query — never string concatenation

  alt Duplicate email
    DB-->>AS: UNIQUE constraint error
    AS-->>H: Generic "Registration failed" error
    Note over H: Never reveal whether email exists
  end

  DB-->>AS: ResultSet
  AS-->>H: Success
  H-->>U: 201 {success: true} or redirect
```

**Source:** [`account-service.ts:108-130`](../packages/core/src/auth/services/account-service.ts) | [`password-service.ts:203-249`](../packages/core/src/auth/services/password-service.ts)

---

## 2. Login

Full authentication flow from credential verification through token issuance.

```mermaid
sequenceDiagram
  participant U as User Agent
  participant H as Hono Worker
  participant AS as AccountService
  participant PS as PasswordService
  participant SS as SessionService
  participant TS as TokenService
  participant DB as Turso DB

  U->>H: POST /api/login {email, password}
  H->>AS: authenticate(input, env)

  AS->>AS: loginSchema.safeParseAsync(input)
  AS->>DB: SELECT password_data, id FROM account WHERE email = ?

  alt User not found (0 rows)
    AS->>PS: rejectPasswordWithConstantTime(password)
    Note over PS: Runs full PBKDF2 against dummy hash<br/>to equalize response time.<br/>Prevents timing-based user enumeration.
    PS-->>AS: false (always)
    AS-->>H: {authenticated: false, error: "Invalid email or password"}
  end

  AS->>PS: verifyPassword(password, storedPasswordData)
  Note over PS: 1. parsePasswordString() — extract salt, iterations<br/>2. PBKDF2 deriveBits with stored parameters<br/>3. timingSafeEqual() via crypto.subtle.verify()
  PS-->>AS: true / false

  alt Password incorrect
    AS-->>H: {authenticated: false, error: "Invalid email or password"}
    Note over H: Same error message as "user not found"
    H-->>U: 401 {error: "Authentication failed"}
  end

  AS-->>H: {authenticated: true, userId}

  H->>SS: createSession(userId, ctx)
  SS->>DB: DELETE expired sessions
  SS->>DB: Enforce max 3 sessions (CTE + ROW_NUMBER)
  SS->>SS: nanoid() — 21 chars, ~121 bits entropy
  SS->>DB: INSERT INTO session (id, user_id, user_agent, ip_address, expires_at, created_at)
  SS-->>H: sessionId

  H->>TS: generateTokens(ctx, userId, sessionId)
  Note over TS: Access: {uid, sid, typ:"access", exp:+15min}<br/>Refresh: {uid, sid, typ:"refresh", exp:+7d}<br/>Signed with separate secrets (HS256)
  TS->>U: Set-Cookie: access_token (HttpOnly, Secure, SameSite=Strict)
  TS->>U: Set-Cookie: refresh_token (HttpOnly, Secure, SameSite=Strict)

  H-->>U: 200 {success: true} or redirect
```

**Source:** [`account-service.ts:132-196`](../packages/core/src/auth/services/account-service.ts) | [`session-service.ts:204-248`](../packages/core/src/auth/services/session-service.ts) | [`token-service.ts:67-114`](../packages/core/src/auth/services/token-service.ts) | [`app.ts:67-105`](../apps/cloudflare-workers/src/app.ts)

---

## 3. Normal API Request

Accessing a protected endpoint with a valid access token.

```mermaid
sequenceDiagram
  participant U as User Agent
  participant MW as requireAuth Middleware
  participant JWT as hono/jwt verify()
  participant SS as SessionService
  participant DB as Turso DB
  participant RH as Route Handler

  U->>MW: GET /api/ping (Cookie: access_token=...)
  MW->>MW: getCookie(ctx, "access_token")

  MW->>JWT: verify(token, JWT_ACCESS_SECRET, AlgorithmTypes.HS256)
  Note over JWT: Explicit HS256 prevents<br/>algorithm confusion attacks

  JWT-->>MW: payload {uid, sid, typ:"access", exp}

  MW->>MW: Check payload.typ === "access"

  MW->>SS: getSession(ctx)
  SS->>DB: UPDATE session SET expires_at = now + 7d WHERE id = ? AND expires_at > now
  Note over SS,DB: Sliding expiration — extends on each use
  SS->>DB: SELECT * FROM session WHERE id = ?
  SS-->>MW: session {id, userId, ...}

  MW->>MW: Verify session.id === payload.sid

  MW->>RH: next()
  RH-->>U: 200 {message: "pong", userId: 1}
```

**Source:** [`require-auth.ts:67-124`](../packages/core/src/auth/middleware/require-auth.ts) | [`require-auth.ts:163-191`](../packages/core/src/auth/middleware/require-auth.ts) (verifyToken) | [`session-service.ts:250-276`](../packages/core/src/auth/services/session-service.ts)

---

## 4. Token Refresh

When the access token expires, the middleware transparently refreshes it using the refresh token.

```mermaid
sequenceDiagram
  participant U as User Agent
  participant MW as requireAuth Middleware
  participant JWT as hono/jwt verify()
  participant SS as SessionService
  participant TS as TokenService
  participant DB as Turso DB

  U->>MW: GET /api/ping [Cookie: access_token + refresh_token]

  MW->>JWT: verify(accessToken, JWT_ACCESS_SECRET, HS256)
  JWT-->>MW: Throws (expired)
  Note over MW: Access token invalid — enter refresh flow

  MW->>MW: getCookie(ctx, "refresh_token")

  alt No refresh token
    MW-->>U: 401 {code: "TOKEN_EXPIRED"}
  end

  MW->>JWT: verify(refreshToken, JWT_REFRESH_SECRET, HS256)
  Note over JWT: Separate secret from access token<br/>prevents cross-type forgery
  JWT-->>MW: payload {uid, sid, typ:"refresh", exp}

  MW->>MW: Check payload.typ === "refresh"

  MW->>SS: getSession(ctx)
  SS->>DB: Extend + SELECT session
  SS-->>MW: session or null

  alt Session revoked or expired
    MW-->>U: 403 {code: "SESSION_REVOKED"}
  end

  MW->>MW: Verify session.id === payload.sid

  MW->>TS: refreshAccessToken(ctx, refreshPayload)
  Note over TS: New payload: {uid, sid, typ:"access", exp:+15min}<br/>Signed with JWT_ACCESS_SECRET
  TS->>U: Set-Cookie: access_token (new token)

  MW->>JWT: verify(newAccessToken, JWT_ACCESS_SECRET, HS256)
  JWT-->>MW: payload (validated)

  MW->>MW: next()
  MW-->>U: 200 (original request succeeds)
```

**Source:** [`require-auth.ts:85-103`](../packages/core/src/auth/middleware/require-auth.ts) | [`token-service.ts:116-143`](../packages/core/src/auth/services/token-service.ts)

---

## 5. Logout

Ends the server-side session and clears both auth cookies.

```mermaid
sequenceDiagram
  participant U as User Agent
  participant H as Hono Worker
  participant MW as requireAuth Middleware
  participant SS as SessionService
  participant DB as Turso DB

  U->>H: POST /api/logout [Cookie: access_token + refresh_token]

  H->>MW: requireAuth middleware validates token
  MW-->>H: Authenticated (sets jwtPayload in context)

  H->>SS: endSession(ctx)
  SS->>SS: Extract payload.sid from context
  SS->>DB: UPDATE session SET expires_at = datetime('now') WHERE id = ?
  Note over SS,DB: Session expires immediately<br/>but row kept for audit trail

  SS->>U: Set-Cookie: access_token="" (delete)
  SS->>U: Set-Cookie: refresh_token="" (delete)

  H-->>U: 200 {success: true} or redirect
```

**Source:** [`session-service.ts:278-294`](../packages/core/src/auth/services/session-service.ts) | [`app.ts:107-124`](../apps/cloudflare-workers/src/app.ts)

---

## 6. Password Change (Not Yet Implemented)

> **Gap:** Password change is not yet implemented. See [ADR-002](adr/002-future-enhancements.md) for planned work and the [threat model](threat-model.md) for security implications.

The expected flow when implemented:

```mermaid
sequenceDiagram
  participant U as User Agent
  participant H as Hono Worker
  participant MW as requireAuth Middleware
  participant AS as AccountService
  participant PS as PasswordService
  participant SS as SessionService
  participant DB as Turso DB

  U->>H: POST /api/change-password {currentPassword, newPassword}
  H->>MW: requireAuth (verify existing session)
  MW-->>H: Authenticated (userId from token)

  H->>AS: verifyCurrentPassword(userId, currentPassword)
  AS->>DB: SELECT password_data WHERE id = ?
  AS->>PS: verifyPassword(currentPassword, stored)
  Note over PS: Must re-verify current password<br/>even though user is authenticated

  alt Current password incorrect
    AS-->>H: 401 Unauthorized
  end

  H->>PS: hashPassword(newPassword)
  Note over PS: Full PBKDF2 hash with fresh salt

  H->>DB: UPDATE account SET password_data = ? WHERE id = ?

  H->>SS: Revoke all other sessions for userId
  Note over SS: Force re-authentication on other devices

  H-->>U: 200 {success: true}
```
