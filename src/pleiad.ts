// @ts-ignore - Hono will be installed
import { Hono } from 'hono';
import { OAuthManager } from './oauth.js';
import type { PleiadConfig, ProviderConfig } from './types.js';
import OpenAI from 'openai';
import open from 'open';

export default class Pleiad {
  private app: Hono;
  private oauthManager: OAuthManager;
  private providers: Map<string, ProviderConfig>;
  private sessions: Map<string, string>; // Maps "userId:providerId" -> sessionId
  private openai: OpenAI;

  constructor(private config: PleiadConfig) {
    this.sessions = new Map();
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    this.app = new Hono();
    this.providers = new Map(config.providers.map(p => [p.id, p]));
    // baseUrl not stored; OAuthManager handles it
    
    // Extract OAuth specs for OAuthManager
    const oauthSpecs = new Map(
      Array.from(this.providers.entries())
        .filter(([_, p]) => p.oauth)
        .map(([id, p]) => [id, p.oauth!])
    );
    
    this.oauthManager = new OAuthManager(
      config.store,
      oauthSpecs,
      config.baseUrl
    );

    this.setupRoutes();
  }

  private setupRoutes() {
    // Single OAuth callback endpoint (no provider slug)
    this.app.get('/oauth/callback', async (c: any) => {
      const code = c.req.query('code');
      const state = c.req.query('state');
      
      if (!code || !state) {
        return c.html(`
          <h1>Authorization Error</h1>
          <p>Missing parameters</p>
        `, 400);
      }

      try {
        const result = await this.oauthManager.handleCallback(code, state);
        const { providerId, token } = result;

        // Authorization succeeded; render minimal confirmation

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
    });

    // MCP endpoint
    this.app.post('/mcp', async (c: any) => {
      return this.handleMCPRequest(c);
    });
  }

  private async handleMCPRequest(c: any) {
    const request = await c.req.json();
    
    try {
    
    if (request.method === 'initialize') {
      // MCP initialize - required by protocol
      return c.json({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: {
            tools: { listChanged: true },
            prompts: { listChanged: true },
            resources: { listChanged: true }
          },
          serverInfo: {
            name: this.config.name,
            version: '0.1.0'
          }
        }
      } as any);
    }
    
    if (request.method === 'notifications/initialized') {
      // Notifications don't need responses
      return c.json({ jsonrpc: '2.0' } as any);
    }
    
    if (request.method === 'tools/list') {
      // Return single meta-tool that routes to all providers
      const tools = [{
        name: 'use_pleiad',
        description: 'Execute actions across integrated services (Linear, Sentry, etc.). The agent will automatically select the right service and tools based on your request.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Natural language request describing what you want to do' }
          },
          required: ['prompt']
        }
      }];

      return c.json({
        jsonrpc: '2.0',
        id: request.id,
        result: { tools }
      } as any);
    }
    
    if (request.method === 'tools/call') {
      const toolName = request.params.name;

      if (toolName === 'use_pleiad') {
        // Route to agent
        const userId = this.getUserId(c);
        const result = await this.handleAgentTool(request.params.arguments, userId, request.id);
        return c.json(result as any);
      }

      return c.json({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32602, message: `Unknown tool: ${toolName}` }
      });
    }

    if (request.method === 'prompts/list') {
      // No prompts defined
      return c.json({
        jsonrpc: '2.0',
        id: request.id,
        result: { prompts: [] }
      } as any);
    }

    if (request.method === 'resources/list') {
      // No resources defined
      return c.json({
        jsonrpc: '2.0',
        id: request.id,
        result: { resources: [] }
      } as any);
    }

      return c.json({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: 'Method not found' }
      });
    } catch (error: any) {
      // Swallow internal details and return JSON-RPC error shape
      return c.json({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32603, message: error.message }
      });
    }
  }

  private async handleAgentTool(
    args: { prompt: string },
    userId: string,
    requestId: number
  ) {
    try {
      // Step 1: Get list of authenticated providers
      const authenticatedProviders: Array<{ id: string; description: string }> = [];

      for (const [id, provider] of this.providers.entries()) {
        if (provider.oauth) {
          const token = await this.oauthManager.getToken(userId, id);
          if (token) {
            authenticatedProviders.push({
              id,
              description: `${id} - authenticated`
            });
          }
        } else {
          // Provider doesn't require auth
          authenticatedProviders.push({
            id,
            description: `${id} - no authentication required`
          });
        }
      }

      if (authenticatedProviders.length === 0) {
        // Generate auth URLs for all providers that need authentication
        const authUrls: Record<string, string> = {};
        for (const [id, provider] of this.providers.entries()) {
          if (provider.oauth) {
            authUrls[id] = this.oauthManager.getAuthorizationUrl(id, userId);
          }
        }

        // Automatically open each auth URL in the browser
        for (const [providerId, authUrl] of Object.entries(authUrls)) {
          open(authUrl).catch(err => {
            // ignore open errors
          });
        }

        return {
          jsonrpc: '2.0',
          id: requestId,
          error: {
            code: -32603,
            message: 'No authenticated providers available. Opening browser for authentication...',
            data: {
              needsAuth: true,
              providers: authUrls
            }
          }
        };
      }

      // Step 2: Ask OpenAI which provider to use
      const providerSelectionResponse = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a router that selects which service provider to use based on the user's request. Available providers: ${JSON.stringify(authenticatedProviders)}. Respond with ONLY the provider ID, nothing else.`
          },
          {
            role: 'user',
            content: args.prompt
          }
        ],
        temperature: 0
      });

      const providerSelectionContent = providerSelectionResponse.choices?.[0]?.message?.content;
      const selectedProviderId = providerSelectionContent ? providerSelectionContent.trim().toLowerCase() : null;
      if (!selectedProviderId) {
        return {
          jsonrpc: '2.0',
          id: requestId,
          error: { code: -32603, message: 'Could not determine provider' }
        };
      }
      const provider = this.providers.get(selectedProviderId!);
      if (!provider) {
        return {
          jsonrpc: '2.0',
          id: requestId,
          error: {
            code: -32603,
            message: `Provider ${selectedProviderId} not found`
          }
        };
      }

      // Step 3: Get tools from the selected provider
      const providerTools = await this.getProviderTools(provider, userId);
      // Step 4: Ask OpenAI which tool to call and with what arguments
      const toolSelectionResponse = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a tool selector. Given a user request and available tools, you must select the best tool and extract the arguments. Available tools: ${JSON.stringify(providerTools)}`
          },
          {
            role: 'user',
            content: args.prompt
          }
        ],
        tools: providerTools.map((tool: any) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.inputSchema || {}
          }
        })),
        tool_choice: 'required'
      });

      const toolCall = (toolSelectionResponse.choices?.[0] as any)?.message?.tool_calls?.[0] as any;
      if (!toolCall) {
        return {
          jsonrpc: '2.0',
          id: requestId,
          error: {
            code: -32603,
            message: 'Could not determine which tool to use'
          }
        };
      }

      const selectedTool = toolCall.function?.name as string | undefined;
      const toolArgs = (() => {
        try { return JSON.parse(toolCall.function?.arguments ?? '{}'); } catch { return {}; }
      })();
      if (!selectedTool) {
        return {
          jsonrpc: '2.0',
          id: requestId,
          error: { code: -32603, message: 'Tool selection missing name' }
        };
      }

      // Step 5: Execute the tool on the provider
      const result = await this.executeProviderTool(
        selectedProviderId!,
        selectedTool,
        toolArgs,
        userId
      );

      return {
        jsonrpc: '2.0',
        id: requestId,
        result
      };

    } catch (error: any) {
      return {
        jsonrpc: '2.0',
        id: requestId,
        error: {
          code: -32603,
          message: error.message || 'Agent execution failed'
        }
      };
    }
  }

  // removed unused handleProviderTool

  private getUserId(c: any): string {
    // Extract user ID from request (e.g., Authorization header)
    return c.req.header('Authorization') || 'default-user';
  }

  private async getProviderTools(provider: ProviderConfig, userId: string): Promise<any[]> {
    // Get or create session
    const sessionKey = `${userId}:${provider.id}`;
    let sessionId = this.sessions.get(sessionKey);

    if (!sessionId) {
      const token = provider.oauth ? await this.oauthManager.getToken(userId, provider.id) : null;
      const tempSessionId = crypto.randomUUID();
      sessionId = await this.initializeSession(provider.mcpUrl, tempSessionId, token);
      this.sessions.set(sessionKey, sessionId);
    }

    // Get token if OAuth provider
    const token = provider.oauth ? await this.oauthManager.getToken(userId, provider.id) : null;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId ?? ''
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token.accessToken}`;
    }

    const response = await fetch(provider.mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Math.floor(Math.random() * 1000000),
        method: 'tools/list',
        params: {}
      })
    });

    const contentType = response.headers.get('Content-Type');
    const responseText = await response.text();

    let result: any;
    if (contentType?.includes('text/event-stream')) {
      const dataLines = responseText.split('\n').filter(line => line.startsWith('data: '));
      const firstLine = dataLines.length > 0 ? dataLines[0] : undefined;
      result = firstLine ? JSON.parse(firstLine.substring(6)) : (responseText ? JSON.parse(responseText) : {});
    } else {
      result = responseText ? JSON.parse(responseText) : {};
    }

    return result.result?.tools || [];
  }

  private async executeProviderTool(
    providerId: string,
    toolName: string,
    toolArgs: any,
    userId: string
  ): Promise<any> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Provider ${providerId} not found`);
    }

    // Get or create session
    const sessionKey = `${userId}:${providerId}`;
    let sessionId = this.sessions.get(sessionKey);

    if (!sessionId) {
      const token = provider.oauth ? await this.oauthManager.getToken(userId, providerId) : null;
      const tempSessionId = crypto.randomUUID();
      sessionId = await this.initializeSession(provider.mcpUrl, tempSessionId, token);
      this.sessions.set(sessionKey, sessionId);
    }

    // Get token if OAuth provider
    const token = provider.oauth ? await this.oauthManager.getToken(userId, providerId) : null;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId ?? ''
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token.accessToken}`;
    }

    const response = await fetch(provider.mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Math.floor(Math.random() * 1000000),
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: toolArgs
        }
      })
    });

    const contentType = response.headers.get('Content-Type');
    const responseText = await response.text();

    let result: any;
    if (contentType?.includes('text/event-stream')) {
      const dataLines = responseText.split('\n').filter(line => line.startsWith('data: '));
      const firstLine = dataLines.length > 0 ? dataLines[0] : undefined;
      result = firstLine ? JSON.parse(firstLine.substring(6)) : (responseText ? JSON.parse(responseText) : {});
    } else {
      result = responseText ? JSON.parse(responseText) : {};
    }

    if (result.error) {
      throw new Error(result.error.message || 'Tool execution failed');
    }

    return result.result;
  }

  private async initializeSession(mcpUrl: string, sessionId: string, token: any): Promise<string> {

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
      // NOTE: Do NOT send Mcp-Session-Id during initialize
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token.accessToken}`;
    }

    const response = await fetch(mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {
            roots: { listChanged: false },
            sampling: {}
          },
          clientInfo: {
            name: 'pleiad',
            version: '0.1.0'
          }
        }
      })
    });

    // Check if server returned session ID in header
    const serverSessionId = response.headers.get('Mcp-Session-Id');
    const contentType = response.headers.get('Content-Type');

    // Parse the response
    const responseText = await response.text();

    // If it's SSE format, we may need to extract JSON from event data
    let result: any;
    if (contentType?.includes('text/event-stream')) {
      // Parse SSE format: look for data: lines
      const dataLines = responseText.split('\n').filter(line => line.startsWith('data: '));
      const firstLine = dataLines.length > 0 ? dataLines[0] : undefined;
      result = firstLine ? JSON.parse(firstLine.substring(6)) : (responseText ? JSON.parse(responseText) : {});
    } else {
      result = responseText ? JSON.parse(responseText) : {};
    }

    if (result.error) {
      // Handle different error formats
      const errorMessage = result.error_description || result.error.message || result.error;
      throw new Error(`Failed to initialize session: ${errorMessage}`);
    }

    // Return the session ID from server, or fallback to the one we generated
    return serverSessionId || sessionId;
  }

  get fetch() {
    return this.app.fetch.bind(this.app);
  }
}
