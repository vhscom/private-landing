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

# Open interactive SQL shell
turso db shell auth-db
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

## License

LGPL - Open source with required code sharing.