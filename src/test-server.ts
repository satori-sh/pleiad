import Pleiad from './pleiad.js';
import type { PleiadConfig } from './types.js';

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

// Configure Pleiad with test providers
const pleiadConfig: PleiadConfig = {
  name: 'test-aggregator',
  baseUrl: process.env.PLEIAD_BASE_URL || 'http://localhost:8787',
  providers: [
  {
    id: 'linear',
    mcpUrl: 'https://mcp.linear.app/mcp', // Placeholder - update with actual URL
    oauth: {
      authUrl: 'https://linear.app/oauth/authorize',
      tokenUrl: 'https://api.linear.app/oauth/token',
      clientId: process.env.LINEAR_CLIENT_ID || '',
      clientSecret: process.env.LINEAR_CLIENT_SECRET || '',
      scopes: ['read', 'write']
    }
  },
  {
    id: 'sentry',
    mcpUrl: 'https://mcp.sentry.dev/mcp',
    oauth: {
      authUrl: 'https://mcp.sentry.dev/oauth/authorize',
      tokenUrl: 'https://mcp.sentry.dev/oauth/token',
      clientId: 'J05zVqgrYi2fAGwI', // Dynamically registered public client
      clientSecret: '', // Public client - no secret
      scopes: ['org:read', 'project:write', 'team:write', 'event:write']
    }
  }
  ],
  store: tokenStore as any
};

// Create Pleiad instance
const pleiad = new Pleiad(pleiadConfig);

// Simple HTTP server for testing
const port = parseInt(process.env.PORT || '1337');

const server = Bun.serve({
  port,
  fetch: pleiad.fetch,
});

console.log('Server running at http://localhost:' + port);
console.log('MCP endpoint: http://localhost:' + port + '/mcp');
console.log('OAuth callback base URL:', process.env.PLEIAD_BASE_URL || 'http://localhost:8787');
console.log('OAuth callback: http://localhost:' + port + '/oauth/callback');