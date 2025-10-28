import type { OAuthManager } from './oauth.js';
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
  agentHandler: (args: { prompt: string; providerId: string }, userId: string, requestId: number | string) => Promise<any>
) {
  return async (c: any) => {
    const request = await c.req.json();
    
    try {
      if (request.method === 'initialize') {
        return c.json(tools.handleInitialize(config as any, request.id));
      }
      
      if (request.method === 'tools/list') {
        return c.json(tools.handleToolsList(config.providers, request.id));
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

