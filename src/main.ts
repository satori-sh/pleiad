// @ts-ignore - Hono will be installed
import { Hono } from 'hono';
import { OAuthManager } from './oauth.js';
import type { PleiadesConfig, ProviderConfig } from './types.js';
import { AIAgent } from './ai.js';
import { MCPClient } from './client.js';
import { handleOAuthCallback, createMCPRouteHandler, handleOAuthRefresh } from './routes.js';
import { InngestPublisher, NoopPublisher } from './scheduler.js';

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
  private publisher: InngestPublisher | NoopPublisher;

  /**
   * @param config - Pleiades server configuration including providers, store, and base URL
   */
  constructor(private config: PleiadesConfig) {
    this.app = new Hono();
    this.providers = new Map(config.providers.map(p => [p.id, p]));
    
    // Publisher
    const inngestBase = process.env.INNGEST_BASE_URL || '';
    const inngestKey = process.env.INNGEST_SIGNING_KEY || '';
    const publisher = (inngestBase && inngestKey)
      ? new InngestPublisher(inngestBase, inngestKey)
      : new NoopPublisher();
    this.publisher = publisher;

    this.oauthManager = new OAuthManager(
      config.store,
      this.providers,
      config.baseUrl,
      publisher
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
    this.app.post('/oauth/refresh/:providerId', handleOAuthRefresh(
      this.oauthManager,
      this.providers,
      // reuse same publisher for rescheduling
      this.publisher,
      process.env.INBOUND_SIGNING_KEY || ''
    ));
    
    this.app.post('/mcp', createMCPRouteHandler(
      { name: this.config.name, providers: this.providers },
      (c) => this.getUserId(c),
      async (args: { prompt: string }, userId: string, requestId: number | string) => {
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

