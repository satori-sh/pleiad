import type { OAuthManager } from './oauth.js';
import type { ProviderConfig } from './types.js';
import type { AuthEventPublisher } from './scheduler.js';
import * as tools from './tools.js';

/**
 * HTTP route handlers for Pleiades MCP server
 */

/**
 * Handle OAuth callback from provider
 *
 * Processes OAuth authorization code and stores tokens for the user.
 * Returns HTML confirmation page for the user.
 *
 * @param oauthManager - OAuth token manager
 * @returns Async function that handles the OAuth callback route
 */
export function handleOAuthCallback(oauthManager: OAuthManager) {
  return async (c: any) => {
    const code = c.req.query('code');
    const state = c.req.query('state');

    if (!code || !state) {
      return c.html(`
        <h1>Authorization Error</h1>
        <p>Missing parameters</p>
      `, 400);
    }

    try {
      const result = await oauthManager.handleCallback(code, state);
      const { providerId } = result;

      return c.html(`
        <h1>✓ Authorization Complete!</h1>
        <p>You have successfully authorized ${providerId}.</p>
        <p><strong>Close this window and retry your request.</strong></p>
      `);
    } catch (error) {
      return c.html(`
        <h1>Error</h1>
        <p>${error instanceof Error ? error.message : 'Unknown error'}</p>
      `, 500);
    }
  };
}

/**
 * Create MCP protocol route handler
 * 
 * Handles JSON-RPC requests to the /mcp endpoint. Dispatches to appropriate
 * MCP protocol handlers (initialize, tools/list, tools/call, etc.) based on
 * the 'method' field in the request.
 * 
 * @param config - Server configuration with name and providers
 * @param getUserId - Function to extract user ID from request context
 * @param agentHandler - Function to execute AI agent for tool calls with provider ID
 * @returns Async Hono handler function for /mcp route
 */
export function createMCPRouteHandler(
  config: { name: string; providers: Map<string, any> },
  getUserId: (c: any) => string,
  agentHandler: (args: { prompt: string }, userId: string, requestId: number | string) => Promise<any>
) {
  return async (c: any) => {
    const request = await c.req.json();
    
    try {
      if (request.method === 'initialize') {
        return c.json(tools.handleInitialize(config as any, request.id));
      }
      
      if (request.method === 'tools/list') {
        return c.json(tools.handleToolsList(request.id));
      }
      
      if (request.method === 'tools/call') {
        const toolName = request.params.name;
        const userId = getUserId(c);
        const result = await tools.handleToolsCall(toolName, request.params.arguments, userId, request.id, config.providers, agentHandler);
        return c.json(result);
      }

      if (request.method === 'prompts/list') {
        return c.json(tools.handlePromptsList(request.id));
      }

      if (request.method === 'resources/list') {
        return c.json(tools.handleResourcesList(request.id));
      }

      return c.json({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: 'Method not found' }
      });
    } catch (error: any) {
      return c.json({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32603, message: error.message }
      });
    }
  };
}

/**
 * Handle OAuth token refresh callback from the background scheduler.
 *
 * This endpoint is intended to be called by a trusted scheduler service
 * whenever a token is approaching expiry. It verifies the request using
 * an HMAC signature and, if valid, refreshes the user's token for the
 * specified provider. On success, it may schedule the next refresh based
 * on the new expiry time and provider-specific lead time.
 *
 * Route shape: POST /oauth/refresh/:providerId
 * Headers:
 *   - X-Signature: base64-encoded HMAC-SHA256 of the raw request body
 * Body (JSON):
 *   - userId: string (required) — Principal whose token should be refreshed
 *   - accountId?: string (optional, defaults to "default") — Account slot
 *
 * Security:
 *   - If an inbound signing key is provided, the request must include a
 *     valid X-Signature header. Otherwise the request is rejected with 401.
 *
 * Behavior:
 *   1) Verify signature (when configured)
 *   2) Refresh token for (userId, providerId)
 *   3) Compute next run time using provider.refresh.leadMs (default 10m)
 *   4) Schedule the next refresh via the provided publisher
 *
 * Responses:
 *   - 200: { expiresAt: number | undefined, nextRunAt: number | undefined }
 *   - 400: { error: 'missing_params' } when userId or providerId missing
 *   - 401: { error: 'invalid_signature' } when signature verification fails
 *   - 409: { error: 'NO_REFRESH_TOKEN' | 'TOKEN_REFRESH_FAILED', reauthorizeUrl? }
 *   - 500: { error: 'unknown', message: string }
 *
 * @param oauthManager - OAuth manager used to refresh and authorize tokens
 * @param providers - Map of provider configurations keyed by provider id
 * @param publisher - Scheduler publisher used to enqueue the next refresh
 * @param inboundSigningKey - HMAC key used to validate the X-Signature header
 * @returns Hono handler that processes the refresh request and returns JSON
 */
export function handleOAuthRefresh(
  oauthManager: OAuthManager,
  providers: Map<string, ProviderConfig>,
  publisher: AuthEventPublisher,
  inboundSigningKey: string
) {
  return async (c: any) => {
    const providerId = c.req.param('providerId');
    const sig = c.req.header('X-Signature') || '';
    const bodyText = await c.req.text();

    // Verify signature
    if (inboundSigningKey) {
      const enc = new TextEncoder();
      const key = await crypto.subtle.importKey('raw', enc.encode(inboundSigningKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const mac = await crypto.subtle.sign('HMAC', key, enc.encode(bodyText));
      const bytes = new Uint8Array(mac);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const expected = btoa(bin);
      if (expected !== sig) {
        return c.json({ error: 'invalid_signature' }, 401);
      }
    }

    const { userId, accountId = 'default' } = JSON.parse(bodyText || '{}');
    if (!userId || !providerId) return c.json({ error: 'missing_params' }, 400);

    try {
      const token = await oauthManager.refreshToken(userId, providerId);
      const provider = providers.get(providerId);
      const lead = provider?.refresh?.leadMs ?? 600_000;
      let runAt: number | undefined;
      if (typeof token.expiresAt === 'number') {
        runAt = Math.max(0, token.expiresAt - lead);
      }

      if (typeof runAt === 'number') {
        await publisher.scheduleRefresh({ userId, providerId, accountId, runAt: runAt as number });
      }

      const nextRunAt = typeof runAt === 'number' ? runAt : undefined;
      return c.json({ expiresAt: token.expiresAt, nextRunAt });
    } catch (err: any) {
      if (err?.code === 'NO_REFRESH_TOKEN' || err?.code === 'TOKEN_REFRESH_FAILED') {
        try {
          const reauthorizeUrl = await oauthManager.getAuthorizationUrl(providerId, userId);
          return c.json({ error: err.code, reauthorizeUrl }, 409);
        } catch {
          return c.json({ error: err.code }, 409);
        }
      }
      return c.json({ error: 'unknown', message: err?.message || String(err) }, 500);
    }
  };
}

