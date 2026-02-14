# Contributing to Private Landing

Thank you for your interest in contributing! This guide will help you get started.

## Prerequisites

- [Bun](https://bun.sh/) >= 1.0.0
- [Node.js](https://nodejs.org/) >= 24.0.0
- A [Turso](https://turso.tech/) database (for integration tests)
- An [Upstash](https://upstash.com/) Redis database (optional, for cache-backed session testing)

## Getting Started

1. **Clone the repository**

   ```bash
   git clone https://github.com/vhscom/private-landing.git
   cd private-landing
   ```

2. **Install dependencies**

   ```bash
   bun install
   ```

3. **Build packages**

   ```bash
   bun run build
   ```

4. **Run the development server**

   ```bash
   bun run dev
   ```

   The worker will be available at `http://localhost:8788`.

## Project Structure

```
.
├── apps/
│   └── cloudflare-workers/    # Hono app deployed to Cloudflare Workers
├── packages/
│   ├── core/                  # Auth middleware, services, crypto utilities
│   ├── infrastructure/        # Database client, cache client, static file serving
│   ├── schemas/               # Zod validation schemas
│   └── types/                 # Shared TypeScript types and errors
└── docs/
    ├── adr/                   # Architecture Decision Records
    └── audits/                # Security audit reports
```

## Testing

### Unit Tests

Unit tests are co-located with packages and run via Vitest:

```bash
# Run all unit tests
bun run test:unit

# Run with coverage
bun run test:coverage

# Watch mode
bun run test:watch
```

### Integration Tests

Integration tests require a Turso database. Copy the example env file and configure your credentials:

```bash
cd apps/cloudflare-workers
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your Turso credentials
```

The same `.dev.vars` file is used for both local development and integration tests. A separate `.dev.vars.production` (see `.dev.vars.production.example`) is used for the deployed Workers environment.

Then run:

```bash
bun run test:integration
```

#### Cache-backed sessions (optional)

To test cache-backed sessions locally, create an [Upstash](https://upstash.com/) Redis database and add the REST credentials to `.dev.vars`:

```
CACHE_URL="https://your-db.upstash.io"
CACHE_TOKEN="your-upstash-token"
```

To choose the best region, check where your Turso database is located:

```bash
turso db list && turso db show <your-db-name>
```

Pick the Upstash region closest to your Turso primary. The free tier (10k commands/day) is sufficient for development and testing. Without these variables, the app uses SQL-backed sessions by default.

### Adding Tests

- **Unit tests**: Add test files alongside source files using the pattern `*.test.ts`
- **Integration tests**: Add to `apps/cloudflare-workers/test/integration/`
- Follow existing test patterns and use descriptive test names
- Aim for high coverage on security-critical code paths

## Code Style

This project uses [Biome](https://biomejs.dev/) for linting and formatting.

```bash
# Check linting
bun run lint

# Format code
bun run format

# Type check
bun run typecheck
```

All code must pass linting, formatting, and type checks before merging.

## Proposing Features

1. **Open an issue first** — Describe the feature, its use case, and how it aligns with the project's educational goals.

2. **Fork and branch** — Create a feature branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```

3. **Make your changes** — Follow existing code patterns and include tests.

4. **Run all checks**:
   ```bash
   bun run build
   bun run typecheck
   bun run lint
   bun run test
   ```

5. **Submit a pull request** — Reference the issue and describe your changes.

## Commit Requirements

- **All commits must be signed and verified** — See [GitHub's guide to signing commits](https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-commits)
- **Co-authorship is not permitted** — Each commit must have a single author; `Co-Authored-By` trailers are not allowed

## Pull Request Guidelines

- Keep PRs focused and reasonably sized
- Include tests for new functionality
- Update documentation if needed
- Ensure CI passes before requesting review
- All commits must be verified (signed)

## Questions?

Open an issue or start a discussion on GitHub.
