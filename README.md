# Pleiades

Unified MCP orchestrator that connects AI agents to multiple providers (Linear, Sentry, etc.) via a single endpoint.

## Quick Start

```bash
bun install
```

```typescript
import Pleiades from './src/main.js';
import type { PleiadesConfig } from './src/types.js';

// Configure providers
const config: PleiadesConfig = {
  name: 'pleiades', //this becomes the `use_pleiades` tool
  baseUrl: 'http://localhost:8787',
  providers: [
    {
      id: 'sentry',
      mcpUrl: 'https://mcp.sentry.dev/mcp',
      oauth: {
        authUrl: 'https://mcp.sentry.dev/oauth/authorize',
        tokenUrl: 'https://mcp.sentry.dev/oauth/token',
        clientId: process.env.SENTRY_CLIENT_ID!,
        clientSecret: process.env.SENTRY_CLIENT_SECRET!,
        scopes: ['org:read', 'project:write']
      }
    },
    {
      id: 'linear',
      mcpUrl: 'https://mcp.linear.app/mcp',
      oauth: {
        authUrl: 'https://linear.app/oauth/authorize',
        tokenUrl: 'https://api.linear.app/oauth/token',
        clientId: process.env.LINEAR_CLIENT_ID!,
        clientSecret: process.env.LINEAR_CLIENT_SECRET!,
        scopes: ['read', 'write']
      }
    },
    ...
  ],
  store: yourTokenStore // Implement TokenStore interface
};

// Create instance
const pleiades = new Pleiades(config);

// Serve
Bun.serve({
  port: 8787,
  fetch: pleiades.fetch
});
```

## Configuration

**Provider Types:**
- **OAuth**: Provide `oauth` configuration for providers that need authentication
- **API Token**: Use `apiToken` for simple token-based auth

**TokenStore Interface:**
```typescript
interface TokenStore {
  getToken(tenantId: string, providerId: string, accountId?: string): Promise<Token | null>;
  setToken(tenantId: string, providerId: string, accountId: string, token: Token): Promise<void>;
  revokeToken(tenantId: string, providerId: string, accountId: string): Promise<void>;
  getAccounts(tenantId: string, providerId: string): Promise<string[]>;
}
```

## Endpoints

- `GET /mcp` - MCP endpoint for AI agents
- `GET /oauth/callback` - OAuth callback handler
- Each provider exposes tools as `use_{providerId}`

## Run Locally

```bash
bun run dev
```

## Deploy
Currently supports Cloudflare Workers. OAuth requires a database for token storage.

### Token auto-refresh (Inngest)

Why: We use Inngest to run durable, delayed jobs that refresh OAuth tokens before expiry. It handles retries and timing reliably. See Inngest docs: [https://www.inngest.com/docs](https://www.inngest.com/docs)

How:
- On token issue/refresh, we publish an `auth/schedule` event with `runAt = expiresAt - leadMs` (default 10m).
- An Inngest function sleeps until `runAt` and calls `POST /oauth/refresh/:providerId`.
- Success returns `nextRunAt`, and the function re-schedules.

Config (env):
- Workers: `INNGEST_BASE_URL`, `INNGEST_SIGNING_KEY`, `INBOUND_SIGNING_KEY`, `BASE_URL`.
- Per provider lead time: add `refresh: { leadMs?: number }` to provider in `PleiadesConfig`.
