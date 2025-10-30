import OpenAI from 'openai';
import open from 'open';
import type { OAuthManager } from './oauth.js';
import type { ProviderConfig, JSONSchema } from './types.js';
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
  private toolCache: Map<string, { tools: MCPTool[]; refreshedAt: number }>; // key: `${userId}:${providerId}`

  // Minimal shapes for tools and tool-calls we care about
  private static readonly EMPTY_ARGS: Record<string, unknown> = {};

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
    this.toolCache = new Map();
  }


  /**
   * Execute agent request with AI-powered provider and tool selection
   * @param args - Request arguments with user prompt and provider ID
   * @param userId - User identifier for authentication
   * @param requestId - JSON-RPC request identifier
   * @returns JSON-RPC response with result or error
   */
  async execute(
    args: { prompt: string },
    userId: string,
    requestId: number | string
  ) {
    try {
      const prompt = args.prompt;

      const authStatuses = await this.getProviderAuthStatus(userId);
      const selectedProviders = await this.selectProviders(prompt, authStatuses);

      if (!selectedProviders || selectedProviders.length === 0) {
        return {
          jsonrpc: '2.0',
          id: requestId,
          error: { code: -32603, message: 'Could not determine which providers to use' }
        };
      }

      // Auth gating: ensure all selected providers are authenticated if required
      const missingAuth: string[] = [];
      for (const providerId of selectedProviders) {
        const provider = this.providers.get(providerId);
        if (provider?.oauth) {
          const token = await this.oauthManager.getToken(userId, providerId);
          if (!token) missingAuth.push(providerId);
        }
      }
      if (missingAuth.length > 0) {
        return this.getNoAuthError(userId, requestId, missingAuth);
      }

      // Load/refresh tools for selected providers and aggregate with namespacing
      const aggregatedTools: AggregatedTool[] = [];
      for (const providerId of selectedProviders) {
        const provider = this.providers.get(providerId);
        if (!provider) continue;

        const cacheKey = `${userId}:${providerId}`;
        const freshToolsRaw = await this.mcpClient.getProviderTools(provider, userId);
        const freshTools: MCPTool[] = (Array.isArray(freshToolsRaw) ? freshToolsRaw : []).map((t: any) => ({
          name: String(t?.name ?? ''),
          description: typeof t?.description === 'string' ? t.description : undefined,
          inputSchema: (t?.inputSchema ?? undefined) as JSONSchema | undefined
        })).filter(t => t.name.length > 0);
        this.toolCache.set(cacheKey, { tools: freshTools, refreshedAt: Date.now() });

        for (const tool of freshTools) {
          aggregatedTools.push({
            providerId,
            name: `${providerId}.${tool.name}`,
            description: tool.description || '',
            inputSchema: tool.inputSchema || {}
          });
        }
      }

      const plannedTools = await this.planTools(prompt, aggregatedTools);
      if (!plannedTools || plannedTools.length === 0) {
        return {
          jsonrpc: '2.0',
          id: requestId,
          error: { code: -32603, message: 'Could not determine which tool(s) to use' }
        };
      }

      const results: Array<{ providerId: string; tool: string; result: unknown }> = [];
      for (const step of plannedTools) {
        const [providerId, rawToolName] = step.name.split('.', 2);
        if (!providerId || !rawToolName) {
          continue;
        }
        const execResult = await this.mcpClient.executeProviderTool(
          providerId,
          rawToolName,
          step.arguments,
          userId,
          this.providers
        );
        results.push({ providerId, tool: rawToolName, result: execResult });
      }

      return {
        jsonrpc: '2.0',
        id: requestId,
        result: results.length === 1 ? results[0] : results
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
  private async getNoAuthError(userId: string, requestId: number | string, providerId?: string | string[]) {
    const authUrls: Record<string, string> = {};

    // If specific provider(s) requested, only authorize those
    if (providerId) {
      const ids = Array.isArray(providerId) ? providerId : [providerId];
      for (const id of ids) {
        const provider = this.providers.get(id);
        if (provider?.oauth) {
          authUrls[id] = await this.oauthManager.getAuthorizationUrl(id, userId);
        }
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
  private async selectProviders(
    prompt: string,
    authenticatedProviders: Array<{ id: string; authenticated: boolean }>
  ): Promise<string[] | null> {
    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a router that selects which service provider(s) to use based on the user's request. Available providers with auth: ${JSON.stringify(authenticatedProviders)}. Respond with a comma-separated list of provider IDs (e.g., "linear,sentry"). If ambiguous, respond with "clarify".`
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0
    });

    const content = response.choices?.[0]?.message?.content?.trim().toLowerCase();
    if (!content) return null;
    if (content === 'clarify') return null;
    const ids = content.split(',').map(s => s.trim()).filter(Boolean);
    return ids.length > 0 ? ids : null;
  }

  /**
   * Use AI to select the appropriate tool and extract arguments from user prompt
   * @param prompt - User's natural language request
   * @param providerTools - Available tools from the selected provider
   * @returns Selected tool name and parsed arguments, or null if selection fails
   */
  private async planTools(
    prompt: string,
    availableTools: AggregatedTool[]
  ): Promise<PlannedToolStep[] | null> {
    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a planner. Given a user request and available tools (possibly across providers), choose the minimal sequence of tool calls to fulfill the request. If one call is sufficient, choose one.'
        },
        { role: 'user', content: prompt }
      ],
      tools: availableTools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.inputSchema || {}
        }
      })),
      tool_choice: 'auto'
    });

    const toolCalls = (response.choices?.[0] as { message?: { tool_calls?: OpenAIToolCall[] } })?.message?.tool_calls;
    if (!toolCalls || toolCalls.length === 0) return null;

    const steps: PlannedToolStep[] = [];
    for (const call of toolCalls) {
      const name = call.function?.name ?? '';
      const rawArgs = call.function?.arguments ?? '';
      if (!name) continue;
      let argsObj: Record<string, unknown> = AIAgent.EMPTY_ARGS;
      try {
        const parsed = rawArgs ? JSON.parse(rawArgs) : {};
        argsObj = (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : AIAgent.EMPTY_ARGS;
      } catch {
        argsObj = AIAgent.EMPTY_ARGS;
      }
      steps.push({ name, arguments: argsObj });
    }
    return steps;
  }
}

// Local helper types
type MCPTool = {
  name: string;
  description?: string;
  inputSchema?: JSONSchema;
};

type AggregatedTool = {
  providerId: string;
  name: string;
  description?: string;
  inputSchema?: JSONSchema;
};

type PlannedToolStep = {
  name: string;
  arguments: Record<string, unknown>;
};

type OpenAIToolCall = {
  type?: string;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  }
};

