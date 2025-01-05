# Learn Auth

Authentication experiment using Hono + Cloudflare Workers.

## Prerequisites

1. Install [Turso CLI](https://docs.turso.tech/reference/cli)
2. Authenticate with Turso:
```bash
turso auth login
```
3. Create database and set up access:
```bash
# Create the database
turso db create auth-db

# Get database info and connection URL
turso db show auth-db

# Create auth token
turso db tokens create auth-db
```

## Database Setup

The database can be managed using SQL scripts in the `src/db` directory:

- `schema.sql`: Creates tables and sets up the schema
- `reset.sql`: Drops all tables for testing/reset
- `migration.sql`: Handles schema updates

```bash
# First time setup: Create tables
turso db shell auth-db < src/db/schema.sql

# Development: Reset database (WARNING: destroys all data)
turso db shell auth-db < src/db/reset.sql && turso db shell auth-db < src/db/schema.sql

# Run migrations (when schema changes)
turso db shell auth-db < src/db/migration.sql

# Verify current tables
turso db shell auth-db "select name from sqlite_master where type='table'"

# Check table structure
turso db shell auth-db ".schema accounts"
```

## Password Data Format

Passwords are stored in a combined format:
```
$pbkdf2-sha384$v1$iterations$salt$hash$digest
```

This format includes:
- Algorithm identifier (pbkdf2-sha384)
- Version number (v1)
- Iteration count
- Base64 encoded salt
- Base64 encoded hash
- Base64 encoded digest

## Environment Setup

1. Copy `.dev.vars.example` to `.dev.vars` for local development
2. For production, [set up the Turso integration](https://developers.cloudflare.com/workers/databases/native-integrations/turso/) in your Cloudflare dashboard:
   - Go to Workers & Pages → Settings → Integrations
   - Add Turso integration
   - Your `TURSO_URL` and `TURSO_AUTH_TOKEN` will be automatically available

## Development

```bash
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

```bash
# Create database backup
turso db dump auth-db > backup.sql

# Restore from backup
turso db shell auth-db < backup.sql

# Interactive SQL shell
turso db shell auth-db

# Quick table data check
turso db shell auth-db "select email, substr(password_data, 0, 30) || '...' from accounts"
```

## License

LGPL - Open source with required code sharing.