// @ts-ignore - Hono will be installed
import { Hono } from 'hono';
import { OAuthManager } from './oauth.js';
import type { PleiadesConfig, ProviderConfig } from './types.js';
import { AIAgent } from './ai.js';
import { MCPClient } from './client.js';
import { handleOAuthCallback, createMCPRouteHandler } from './routes.js';

/**
 * Pleiades - Multi-provider MCP aggregator with AI-powered routing
 * 
 * Orchestrates OAuth, AI agent, and MCP client modules to provide
 * unified access to multiple MCP servers. Acts as both an MCP server
 * (for clients) and an MCP client (to upstream providers).
 * 
 * @class Pleiades
 */
export default class Pleiades {
  private app: Hono;
  private oauthManager: OAuthManager;
  private providers: Map<string, ProviderConfig>;
  private aiAgent: AIAgent;
  private mcpClient: MCPClient;

  /**
   * @param config - Pleiades server configuration including providers, store, and base URL
   */
  constructor(private config: PleiadesConfig) {
    this.app = new Hono();
    this.providers = new Map(config.providers.map(p => [p.id, p]));
    
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

    this.mcpClient = new MCPClient(this.oauthManager);
    
    this.aiAgent = new AIAgent(
      this.oauthManager,
      this.mcpClient,
      this.providers,
      process.env.OPENAI_API_KEY || ''
    );

    this.setupRoutes();
  }

  /**
   * Set up HTTP routes for OAuth callback and MCP protocol
   */
  private setupRoutes() {
    this.app.get('/oauth/callback', handleOAuthCallback(this.oauthManager));
    
    this.app.post('/mcp', createMCPRouteHandler(
      { name: this.config.name, providers: this.providers },
      (c) => this.getUserId(c),
      async (args: { prompt: string; providerId: string }, userId: string, requestId: number | string) => {
        return await this.aiAgent.execute(args, userId, requestId);
      }
    ));
  }

  /**
   * Extract user ID from request context
   * @param c - Hono context
   * @returns User identifier from Authorization header, or 'default-user'
   */
  private getUserId(c: any): string {
    return c.req.header('Authorization') || 'default-user';
  }

  /**
   * Get the Hono fetch handler for this app
   * @returns Fetch function bound to the Hono app
   */
  get fetch() {
    return this.app.fetch.bind(this.app);
  }
}

