import Pleiades from './src/main.js';
import type { PleiadesConfig } from './src/types.js';

// Simple in-memory store for testing
const tokenStore = {
  tokens: new Map<string, any>(),

  async getToken(tenantId: string, providerId: string, accountId = 'default') {
    const key = `${tenantId}:${providerId}:${accountId}`;
    return this.tokens.get(key) || null;
  },

  async setToken(tenantId: string, providerId: string, accountId: string, token: any) {
    const key = `${tenantId}:${providerId}:${accountId}`;
    this.tokens.set(key, token);
  },

  async revokeToken(tenantId: string, providerId: string, accountId: string) {
    const key = `${tenantId}:${providerId}:${accountId}`;
    this.tokens.delete(key);
  },

  async getAccounts(tenantId: string, providerId: string) {
    const accounts: string[] = [];
    for (const key of this.tokens.keys()) {
      if (key.startsWith(`${tenantId}:${providerId}:`)) {
        const accountId = key.split(':')[2];
        if (accountId) accounts.push(accountId);
      }
    }
    return accounts;
  }
};

// Configure Pleiades with test providers
const pleiadesConfig: PleiadesConfig = {
  name: 'pleiades-local',
  baseUrl: process.env.PLEIADES_BASE_URL || 'http://localhost:1337',
  providers: [
    {
      id: 'linear',
      mcpUrl: process.env.LINEAR_MCP_URL || 'https://mcp.linear.app/mcp',
      oauth: {
        authUrl: 'https://mcp.linear.app/authorize',
        tokenUrl: 'https://mcp.linear.app/token',
        clientId: '', // Will be dynamically registered
        clientSecret: '',
        scopes: ['read', 'write'],
        usePKCE: true,
        registrationUrl: 'https://mcp.linear.app/register'
      }
    },
    {
      id: "vercel_domains",
      mcpUrl: process.env.VERCEL_DOMAINS_MCP_URL || 'https://vercel.com/api/v1/registrar/mcp',
    },
    {
      id: 'sentry',
      mcpUrl: process.env.SENTRY_MCP_URL || 'https://mcp.sentry.dev/mcp',
      oauth: {
        authUrl: 'https://mcp.sentry.dev/oauth/authorize',
        tokenUrl: 'https://mcp.sentry.dev/oauth/token',
        clientId: '', // Will be dynamically registered
        clientSecret: '',
        scopes: ['org:read', 'project:write', 'team:write', 'event:write'],
        usePKCE: true,
        registrationUrl: 'https://mcp.sentry.dev/oauth/register'
      }
    }
  ],
  store: tokenStore as any
};

// Create Pleiades instance
const pleiades = new Pleiades(pleiadesConfig);

// Simple HTTP server for local development
const port = parseInt(process.env.PORT || '1337');

Bun.serve({
  port,
  fetch: pleiades.fetch,
});

console.log('Pleiades running at http://localhost:' + port);

