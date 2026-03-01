# Authentication Flow Diagrams

Sequence diagrams for every authentication flow in Private Landing. Each diagram maps directly to source code in `packages/core/`.

> **Note:** The diagrams below show the default SQL-backed session path. Sessions can optionally be stored in Valkey/Redis cache instead, replacing SQL round-trips with cache GET/SET operations. See [ADR-003](adr/003-cache-layer-valkey.md) for details.

> **Rate limiting:** Fixed-window middleware gates public auth routes before any business logic runs. Requests exceeding the threshold receive `429 Too Many Requests` with a `Retry-After` header. When no cache is configured the rate limiter degrades to a no-op pass-through. See [ADR-006](adr/006-rate-limiting.md).

> **Rendering:** GitHub renders Mermaid natively. For local preview, use the [Mermaid Live Editor](https://mermaid.live) or a VS Code extension.

---

## 1. Registration

User creates a new account. The password is hashed with PBKDF2-SHA384 before storage.

```mermaid
sequenceDiagram
  participant U as User Agent
  participant H as Hono Worker
  participant RL as Rate Limiter
  participant AS as AccountService
  participant PS as PasswordService
  participant DB as Turso DB

  U->>H: POST /auth/register {email, password}
  H->>RL: group limiter (rl:auth 20/300s) then route limiter (rl:register 5/300s) — IP-keyed
  Note over RL: Fixed-window INCR+EXPIRE per client IP.<br/>Both checks run in sequence — either can reject.
  alt Rate limit exceeded
    RL-->>U: 429 {error: "Too many requests", Retry-After: 300}
  end

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

**Source:** [`account-service.ts:125-147`](../packages/core/src/auth/services/account-service.ts) | [`password-service.ts:203-249`](../packages/core/src/auth/services/password-service.ts)

---

## 2. Login

Full authentication flow from credential verification through token issuance.

```mermaid
sequenceDiagram
  participant U as User Agent
  participant H as Hono Worker
  participant RL as Rate Limiter
  participant AS as AccountService
  participant PS as PasswordService
  participant SS as SessionService
  participant TS as TokenService
  participant DB as Turso DB

  U->>H: POST /auth/login {email, password}
  H->>RL: group limiter (rl:auth 20/300s) then route limiter (rl:login 5/300s) — IP-keyed
  Note over RL: Throttles brute-force and credential-stuffing.<br/>429 is returned before any DB lookup occurs.
  alt Rate limit exceeded
    RL-->>U: 429 {error: "Too many requests", Retry-After: 300}
  end

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

**Source:** [`account-service.ts:149-213`](../packages/core/src/auth/services/account-service.ts) | [`session-service.ts:221-268`](../packages/core/src/auth/services/session-service.ts) | [`token-service.ts:67-114`](../packages/core/src/auth/services/token-service.ts) | [`app.ts:185-236`](../apps/cloudflare-workers/src/app.ts)

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

  U->>MW: GET /account/me (Cookie: access_token=...)
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
  RH-->>U: 200 {userId: 1}
```

**Source:** [`require-auth.ts:67-124`](../packages/core/src/auth/middleware/require-auth.ts) | [`require-auth.ts:163-191`](../packages/core/src/auth/middleware/require-auth.ts) (verifyToken) | [`session-service.ts:270-296`](../packages/core/src/auth/services/session-service.ts)

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

  U->>MW: GET /account/me [Cookie: access_token + refresh_token]

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

  U->>H: POST /auth/logout [Cookie: access_token + refresh_token]

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

**Source:** [`session-service.ts:298-314`](../packages/core/src/auth/services/session-service.ts) | [`app.ts:129-153`](../apps/cloudflare-workers/src/app.ts)

---

## 6. Password Change

User changes their password. Requires re-verification of the current password even though the user is authenticated. All sessions are revoked afterward, forcing re-authentication on every device.

```mermaid
sequenceDiagram
  participant U as User Agent
  participant H as Hono Worker
  participant MW as requireAuth Middleware
  participant AS as AccountService
  participant PS as PasswordService
  participant SS as SessionService
  participant DB as Turso DB

  U->>H: POST /account/password {currentPassword, newPassword}
  H->>MW: requireAuth (verify existing session)
  MW-->>H: Authenticated (userId from JWT payload)

  H->>AS: changePassword(input, userId, env)

  AS->>AS: passwordChangeSchema.safeParseAsync(input)
  Note over AS: Zod validates both passwords (8–64 chars,<br/>NFKC normalization) and rejects<br/>newPassword === currentPassword

  alt Validation fails
    AS-->>H: throw ValidationError
    H-->>U: 400 {error, code: "VALIDATION_ERROR"}
  end

  AS->>DB: SELECT password_data FROM account WHERE id = ?

  alt User not found (0 rows)
    AS->>PS: rejectPasswordWithConstantTime(currentPassword)
    Note over PS: Runs full PBKDF2 against dummy hash<br/>to equalize response time
    AS-->>H: throw ValidationError("Password change failed")
  end

  AS->>PS: verifyPassword(currentPassword, stored)
  Note over PS: PBKDF2 + timingSafeEqual via<br/>crypto.subtle.verify()

  alt Current password incorrect
    AS-->>H: throw ValidationError("Password change failed")
    Note over H: Same error as "user not found"
  end

  AS->>PS: hashPassword(newPassword)
  Note over PS: Full PBKDF2 hash with fresh salt
  AS->>DB: UPDATE account SET password_data = ? WHERE id = ?
  AS-->>H: Success

  H->>SS: endAllSessionsForUser(userId, ctx)
  SS->>DB: UPDATE session SET expires_at = datetime('now')<br/>WHERE user_id = ? AND expires_at > datetime('now')
  Note over SS,DB: All sessions expired atomically —<br/>including the current one
  SS->>U: Set-Cookie: access_token="" (delete)
  SS->>U: Set-Cookie: refresh_token="" (delete)

  H-->>U: 200 {success: true} or redirect
```

**Source:** [`account-service.ts:215-268`](../packages/core/src/auth/services/account-service.ts) | [`session-service.ts:316-331`](../packages/core/src/auth/services/session-service.ts) | [`app.ts:239-280`](../apps/cloudflare-workers/src/app.ts) | [ADR-004](adr/004-password-change-endpoint.md)
