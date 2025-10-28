import OpenAI from 'openai';
import open from 'open';
import type { OAuthManager } from './oauth.js';
import type { ProviderConfig } from './types.js';
import type { MCPClient } from './client.js';

/**
 * AIAgent handles intelligent provider and tool selection using OpenAI
 * 
 * Routes user requests to the appropriate provider, selects tools, and handles
 * authentication flow when needed. Uses GPT-4o-mini as default.
 * 
 * @class AIAgent
 */
export class AIAgent {
  private openai: OpenAI;

  /**
   * @param oauthManager - Manages OAuth token lifecycle
   * @param mcpClient - Handles MCP protocol communication with providers
   * @param providers - Available provider configurations
   * @param openaiApiKey - OpenAI API key for AI-powered routing
   */
  constructor(
    private oauthManager: OAuthManager,
    private mcpClient: MCPClient,
    private providers: Map<string, ProviderConfig>,
    openaiApiKey: string
  ) {
    this.openai = new OpenAI({ apiKey: openaiApiKey });
  }


  /**
   * Execute agent request with AI-powered provider and tool selection
   * @param args - Request arguments with user prompt and provider ID
   * @param userId - User identifier for authentication
   * @param requestId - JSON-RPC request identifier
   * @returns JSON-RPC response with result or error
   */
  async execute(
    args: { prompt: string; providerId: string },
    userId: string,
    requestId: number | string
  ) {
    try {
      const providerId = args.providerId;
      const provider = this.providers.get(providerId);
      if (!provider) {
        return {
          jsonrpc: '2.0',
          id: requestId,
          error: { code: -32603 /* JSON-RPC internal error */, message: `Provider ${providerId} not found` }
        };
      }

      // Check if provider needs authentication
      if (provider.oauth) {
        const token = await this.oauthManager.getToken(userId, providerId);
        if (!token) {
          // Provider requires auth but isn't authenticated
          return this.getNoAuthError(userId, requestId, providerId);
        }
      }

      const providerTools = await this.mcpClient.getProviderTools(provider, userId);
      const toolSelection = await this.selectTool(args.prompt, providerTools);
      if (!toolSelection) {
        return {
          jsonrpc: '2.0',
          id: requestId,
          error: { code: -32603 /* JSON-RPC internal error */, message: 'Could not determine which tool to use' }
        };
      }

      const result = await this.mcpClient.executeProviderTool(
        providerId,
        toolSelection.name,
        toolSelection.arguments,
        userId,
        this.providers
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
          code: -32603, // JSON-RPC 2.0: Internal error
          message: error.message || 'Agent execution failed'
        }
      };
    }
  }

  /**
   * Retrieve authentication status for all providers
   * @param userId - User identifier for token lookup
   * @returns Array of providers with their authentication status
   */
  private async getProviderAuthStatus(userId: string): Promise<Array<{ id: string; authenticated: boolean }>> {
    const providers: Array<{ id: string; authenticated: boolean }> = [];

    for (const [id, provider] of this.providers.entries()) {
      if (provider.oauth) {
        const token = await this.oauthManager.getToken(userId, id);
        providers.push({ id, authenticated: !!token });
      } else {
        providers.push({ id, authenticated: true });
      }
    }

    return providers;
  }

  /**
   * Generate authentication error and open browser for OAuth flow
   * @param userId - User identifier for generating auth URLs
   * @param requestId - JSON-RPC request identifier
   * @param providerId - Provider that needs authentication
   * @returns Error response with authentication URLs
   */
  private async getNoAuthError(userId: string, requestId: number | string, providerId?: string) {
    const authUrls: Record<string, string> = {};

    // If specific provider requested, only authorize that one
    if (providerId) {
      const provider = this.providers.get(providerId);
      if (provider?.oauth) {
        authUrls[providerId] = await this.oauthManager.getAuthorizationUrl(providerId, userId);
      }
    } else {
      // Otherwise, show all providers that need auth
      for (const [id, provider] of this.providers.entries()) {
        if (provider.oauth) {
          authUrls[id] = await this.oauthManager.getAuthorizationUrl(id, userId);
        }
      }
    }

    // Automatically open auth URL(s) in the browser
    for (const authUrl of Object.values(authUrls)) {
      open(authUrl).catch(() => {
        // ignore errors for now
      });
    }

    return {
      jsonrpc: '2.0',
      id: requestId,
      error: {
        code: -32603, // JSON-RPC 2.0: Internal error
        message: 'No authenticated providers available. Opening browser for authentication...',
        data: {
          needsAuth: true,
          providers: authUrls
        }
      }
    };
  }

  /**
   * Use AI to select the most appropriate provider based on user prompt
   * @param prompt - User's natural language request
   * @param authenticatedProviders - Available providers with auth status
   * @returns Selected provider ID or null if selection fails
   */
  private async selectProvider(
    prompt: string,
    authenticatedProviders: Array<{ id: string; authenticated: boolean }>
  ): Promise<string | null> {
    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a router that selects which service provider to use based on the user's request. Available providers: ${JSON.stringify(authenticatedProviders)}. Respond with ONLY the provider ID, nothing else.`
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0
    });

    const providerSelectionContent = response.choices?.[0]?.message?.content;
    return providerSelectionContent ? providerSelectionContent.trim().toLowerCase() : null;
  }

  /**
   * Use AI to select the appropriate tool and extract arguments from user prompt
   * @param prompt - User's natural language request
   * @param providerTools - Available tools from the selected provider
   * @returns Selected tool name and parsed arguments, or null if selection fails
   */
  private async selectTool(prompt: string, providerTools: any[]): Promise<{ name: string; arguments: any } | null> {
    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a tool selector. Given a user request and available tools, you must select the best tool and extract the arguments. Available tools: ${JSON.stringify(providerTools)}`
        },
        {
          role: 'user',
          content: prompt
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

    const toolCall = (response.choices?.[0] as any)?.message?.tool_calls?.[0] as any;
    if (!toolCall) {
      return null;
    }

    const selectedTool = toolCall.function?.name as string | undefined;
    const toolArgs = (() => {
      try { return JSON.parse(toolCall.function?.arguments ?? '{}'); } catch { return {}; }
    })();

    if (!selectedTool) {
      return null;
    }

    return { name: selectedTool, arguments: toolArgs };
  }
}

