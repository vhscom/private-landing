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

```bash
# First time setup: Create tables
turso db shell auth-db < src/db/schema.sql

# Development: Reset database (WARNING: destroys all data)
turso db shell auth-db < src/db/reset.sql && turso db shell auth-db < src/db/schema.sql

# Verify current tables
turso db shell auth-db "select name from sqlite_master where type='table'"
```

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
turso db shell auth-db .dump > backup.sql

# Restore from backup
turso db shell auth-db < backup.sql

# Interactive SQL shell
turso db shell auth-db

# Check table structure
turso db shell auth-db ".schema accounts"

# Quick table data check
turso db shell auth-db "select email, created_at from accounts"
```

During development you can reset and recreate the database in one command:
```bash
turso db shell auth-db < src/db/reset.sql && turso db shell auth-db < src/db/schema.sql
```

## License

LGPL - Open source with required code sharing.