# Private Landing

A boilerplate/starter project for quickly building RESTful APIs using [Cloudflare Workers](https://workers.cloudflare.com/), [Hono](https://honojs.dev/) and [Turso](https://turso.tech/). Inspired by Scott Tolinski, Mark Volkmann.

## What's Included

This starter provides a foundation for building authenticated APIs:

- 🔐 **Secure Authentication** - NIST-compliant password storage, JWT-based API auth
- 📱 **Session Management** - Track devices, manage user sessions, auto-refresh tokens
- 🗄️ **SQLite Database** - Purpose-built schema, migrations, and management scripts
- 🚀 **Edge-Ready** - Built for Cloudflare Workers with Hono and Turso
- 💻 **Developer Experience** - TypeScript, automated formatting, comprehensive docs
- ⚡ **Security Features** - Rate limiting ready, following security best practices

Perfect for:
- Building authenticated APIs at the edge
- Starting new SaaS projects quickly
- Learning modern auth implementation

## Authentication System

The authentication system combines secure session management with JWT-based API access control, providing both auditability and stateless verification.

### Core Components

1. **Session Management**
   - Sessions stored in SQLite (via Turso)
   - Tracks user devices, IP addresses, and activity
   - Enforces session limits per user
   - Implements sliding expiration

2. **JWT Tokens**
   - Access token (15min expiry)
   - Refresh token (7 day expiry)
   - Tokens linked to sessions via `session_id`
   - HTTP-only secure cookies

### Authentication Flow

1. **Login Process**:
   ```
   1. Validate input against NIST-compliant schema:
      - Email format verification
      - Password normalization
      - Common password checks
   2. Validate credentials against account table
   3. Create session record with:
      - Unique session ID (nanoid)
      - User agent and IP tracking
      - Configurable expiration
   4. Generate JWT tokens:
      - Access token: {user_id, session_id, type: "access"}
      - Refresh token: {user_id, session_id, type: "refresh"}
   5. Set HTTP-only cookies:
      - access_token: Short-lived API access
      - refresh_token: Long-lived token for renewal
   ```

2. **API Request Authentication**:
   ```
   1. Check access_token cookie
   2. Validate JWT signature and expiry
   3. Verify session still exists and is valid
   4. If token expired:
      a. Check refresh token
      b. Verify refresh token validity
      c. Confirm session is still active
      d. Issue new access token
   5. Update session expiry (sliding window)
   ```

### Security Features

- Type-safe authentication flow
- Schema validation (NIST SP 800-63B compliant)
- Session tracking and limiting
- Secure cookie configuration
- CSRF protection via Same-Site
- Session-JWT linkage for revocation
- IP and user agent tracking
- Sliding session expiration
- Runtime type checking
- No unsafe type assertions

See [ADR-001: Authentication Implementation](docs/adr/001-auth-implementation.md) for detailed technical decisions and security features.

## Database Schema

```mermaid
erDiagram
    account {
        integer id PK
        text email UK "not null"
        text password_data "not null"
        text created_at "default current_timestamp"
    }
    session {
        text id PK
        integer user_id FK "not null"
        text user_agent "not null"
        text ip_address "not null"
        text expires_at "not null"
        text created_at "not null"
    }

    account ||--o{ session: "has"
```

## Prerequisites

1. Install [Turso CLI](https://docs.turso.tech/reference/cli)
2. Authenticate with Turso:
   ```shell
   turso auth login
   ```
3. Create database and set up access:
   ```shell
   # Create the database
   turso db create private-landing-db
   
   # Get database info and connection URL
   turso db show private-landing-db
   
   # Create auth token
   turso db tokens create private-landing-db
   ```

## Database Setup

The database can be managed using SQL scripts in the `sql` directory:

```shell
# First time setup: Create tables
turso db shell private-landing-db < sql/schema.sql

# Development: Reset database (WARNING: destroys all data)
turso db shell private-landing-db < sql/reset.sql && turso db shell private-landing-db < sql/schema.sql

# Run migrations (when schema changes)
turso db shell private-landing-db < sql/migration.sql

# Verify current tables
turso db shell private-landing-db "select name from sqlite_master where type='table'"

# Check table structure
turso db shell private-landing-db ".schema account"
```

## Password Data Format

Passwords are stored in a combined format using industry standard algorithms and NIST SP 800-132 recommendations:

```
$pbkdf2-sha384$v1$iterations$salt$hash$digest
```

Field details:
- Algorithm: PBKDF2 with SHA-384 (balance of security/performance)
- Version: Schema version for future algorithm updates
- Iterations: Key stretching count (100,000)
- Salt: 128-bit random value (NIST recommended minimum)
- Hash: PBKDF2-derived key
- Digest: Additional SHA-384 hash for verification

All binary data (salt, hash, digest) is stored as Base64. The format allows for future algorithm changes while maintaining backward compatibility.

## Environment Setup

1. Copy `.dev.vars.example` to `.dev.vars` for local development
2. For production, [set up the Turso integration](https://developers.cloudflare.com/workers/databases/native-integrations/turso/) in your Cloudflare dashboard:
   - Go to Workers & Pages → Settings → Integrations
   - Add Turso integration
   - Your `TURSO_URL` and `TURSO_AUTH_TOKEN` will be automatically available
3. Use strong passwords for JWT access and refresh token secrets

Required environment variables:
```ini
TURSO_URL="libsql://your-db.turso.io"
TURSO_AUTH_TOKEN="your-auth-token"
JWT_ACCESS_SECRET="your-access-secret"    # For JWT access tokens
JWT_REFRESH_SECRET="your-refresh-secret"  # For JWT refresh tokens
```

## Development

```shell
# Start development server
bun run dev       # Runs on port 8788

# Run tests
bun test

# Format code
bun run format    # Biome formatter

# Check code
bun run check     # Biome linter + formatter check
```

## Database Management

Common database tasks:

```shell
# Create database backup
turso db dump private-landing-db > backup.sql

# Restore from backup
turso db shell private-landing-db < backup.sql

# Interactive SQL shell
turso db shell private-landing-db

# Quick table data check
turso db shell private-landing-db "select email, substr(password_data, 0, 30) || '...' from account"
```

## License

LGPL - Open source with required code sharing.