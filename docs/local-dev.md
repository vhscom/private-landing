# Local Development

Two paths for running Private Landing locally.

## Zero-config (Bun SQLite)

```bash
bun run dev
```

No external services needed. Auto-creates a local SQLite database at `apps/cloudflare-workers/.wrangler/state/local.db` with generated JWT secrets. Ideal for rapid iteration on core auth.

Limitations: tests a different storage path than production (Bun SQLite vs HTTP libSQL). Observability and control plugins are inactive (no `AGENT_PROVISIONING_SECRET` or `GATEWAY_URL`).

Force this mode even when `.dev.vars` exists:

```bash
bun run dev:local
```

## Workers-faithful (wrangler dev)

Uses `wrangler dev` with a remote or local Turso database for full Workers runtime fidelity.

### Setup

1. Copy the example env file:

```bash
cp apps/cloudflare-workers/.dev.vars.example apps/cloudflare-workers/.dev.vars
```

2. Create a Turso database (or use `turso dev` for a local instance):

```bash
turso db create private-landing-dev
turso db tokens create private-landing-dev
```

3. Fill in `.dev.vars` with the database URL and token. Generate JWT secrets:

```bash
openssl rand -hex 32  # JWT_ACCESS_SECRET
openssl rand -hex 32  # JWT_REFRESH_SECRET
```

4. Start the dev server:

```bash
bun run dev
```

The schema is auto-created on first request. No manual migration needed.

### Enabling plugins

**Observability** — Set `AGENT_PROVISIONING_SECRET` to any value. Provision the first agent via curl:

```bash
curl -X POST http://localhost:8788/ops/agents \
  -H 'Content-Type: application/json' \
  -H 'x-provisioning-secret: YOUR_SECRET' \
  -d '{"name": "dev-agent", "trustLevel": "write"}'
```

Save the returned API key — use it as `PLCTL_API_KEY` for the CLI.

**Control** — Set `GATEWAY_URL` to the gateway's HTTP address (e.g., `http://localhost:18789`). The proxy auto-converts to `ws://` for WebSocket connections. Set `GATEWAY_TOKEN` to the gateway auth token.

After starting the dev server, open `http://localhost:8788/ops/control/` (trailing slash required). On first load, the control UI must complete device pairing with the gateway. Append the gateway token as a hash fragment to pair automatically:

```
http://localhost:8788/ops/control/#token=YOUR_GATEWAY_TOKEN
```

The token is consumed once and stripped from the URL. Subsequent loads connect without it. You can verify the device was registered via `openclaw devices list`.

### Local Turso

For offline development without a remote database:

```bash
turso dev --port 8080
```

Use `AUTH_DB_URL="http://127.0.0.1:8080"` with `AUTH_DB_TOKEN` set to any non-empty value (local Turso ignores it, but the client validates its presence).

## Running plugin tests

Plugin integration tests run against a local libSQL server, not the remote Turso database. Start one via Docker:

```bash
docker run -d --name sqld -p 8080:8080 ghcr.io/tursodatabase/libsql-server:latest
```

Or if you have `sqld` installed locally:

```bash
sqld --http-listen-addr 127.0.0.1:8080 &
```

Set your `.dev.vars` to point at the local instance:

```
AUTH_DB_URL="http://127.0.0.1:8080"
AUTH_DB_TOKEN="local"
```

Keep your `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, and `AGENT_PROVISIONING_SECRET` values. Then:

```bash
bun run test:plugins
```

The schema is created automatically by the test setup. The local DB is ephemeral — stop the container to reset.

## Environment variables

See `apps/cloudflare-workers/.dev.vars.example` for the full list with descriptions.
