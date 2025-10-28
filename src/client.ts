import type { Token } from './types.js';
import type { OAuthManager } from './oauth.js';
import type { ProviderConfig } from './types.js';

/**
 * MCPClient manages MCP protocol sessions with upstream providers
 * 
 * Handles session lifecycle, tool discovery, and tool execution for MCP servers.
 * Maintains session state per user/provider combination to enable efficient communication.
 * Note: Tool selection logic lives in AIAgent - this class executes the selected tools.
 * 
 * @class MCPClient
 */
export class MCPClient {
  private sessions: Map<string, string> = new Map();

  /**
   * @param oauthManager - Manages OAuth token retrieval for authenticated providers
   */
  constructor(private oauthManager: OAuthManager) {}

  /**
   * Get or create a session ID for a user/provider combination
   * @param userId - User identifier
   * @param providerId - Provider identifier
   * @returns Session key in format "userId:providerId"
   */
  private getSessionKey(userId: string, providerId: string): string {
    return `${userId}:${providerId}`;
  }

  /**
   * Parse response as JSON or SSE format
   * 
   * Note: This reads the entire response body (not true streaming).
   * For SSE (text/event-stream), extracts JSON from "data: {...}" lines.
   * For standard HTTP streaming with chunked encoding, would need incremental parsing.
   * 
   * @param contentType - Response Content-Type header
   * @param responseText - Raw response body text
   * @returns Parsed JSON object or empty object if parsing fails
   */
  private parseResponse(contentType: string | null, responseText: string): any {
    if (contentType?.includes('text/event-stream')) {
      // SSE format: extract JSON from "data: {...}" lines
      const dataLines = responseText.split('\n').filter(line => line.startsWith('data: '));
      const firstLine = dataLines.length > 0 ? dataLines[0] : undefined;
      return firstLine ? JSON.parse(firstLine.substring(6)) : (responseText ? JSON.parse(responseText) : {});
    } else {
      // Plain JSON response (or chunked HTTP that's been fully read)
      return responseText ? JSON.parse(responseText) : {};
    }
  }

  /**
   * Initialize a new MCP session with a provider
   * 
   * Called when no existing session exists for a user/provider combination.
   * Sends MCP initialize protocol message and returns session ID from server.
   * Session is then cached to avoid re-initialization.
   * 
   * @param mcpUrl - Provider's MCP endpoint URL
   * @param sessionId - Temporary session ID (may be replaced by server)
   * @param token - OAuth token if provider requires authentication
   * @returns Server's session ID or the provided sessionId as fallback
   */
  private async initializeSession(mcpUrl: string, sessionId: string, token: Token | null): Promise<string> {
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
            name: 'pleiades',
            version: '0.1.0'
          }
        }
      })
    });

    // Sentry MCP server returns a custom session ID in response header
    // This is NOT a standard HTTP header - it's Sentry's implementation detail
    const serverSessionId = response.headers.get('Mcp-Session-Id');
    const contentType = response.headers.get('Content-Type');
    const responseText = await response.text();
    const result = this.parseResponse(contentType, responseText);

    if (result.error) {
      const errorMessage = result.error_description || result.error.message || result.error;
      throw new Error(`Failed to initialize session: ${errorMessage}`);
    }

    return serverSessionId || sessionId;
  }

  /**
   * Get list of tools from a provider
   * 
   * Retrieves available tools from the provider's MCP server.
   * Creates or reuses existing session for the user/provider combination.
   * 
   * @param provider - Provider configuration
   * @param userId - User identifier for session management
   * @returns Array of available tools from the provider
   */
  async getProviderTools(
    provider: ProviderConfig,
    userId: string
  ): Promise<any[]> {
    const sessionKey = this.getSessionKey(userId, provider.id);
    let sessionId = this.sessions.get(sessionKey);

    if (!sessionId) {
      const token = provider.oauth ? await this.oauthManager.getToken(userId, provider.id) : null;
      const tempSessionId = crypto.randomUUID();
      sessionId = await this.initializeSession(provider.mcpUrl, tempSessionId, token);
      this.sessions.set(sessionKey, sessionId);
    }

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
    const result = this.parseResponse(contentType, responseText);

    return result.result?.tools || [];
  }

  /**
   * Execute a tool on a provider
   * 
   * Sends tool execution request to the provider's MCP server.
   * Creates or reuses existing session for the user/provider combination.
   * 
   * @param providerId - Provider identifier
   * @param toolName - Name of the tool to execute
   * @param toolArgs - Arguments for the tool execution
   * @param userId - User identifier for session management
   * @param providers - Map of all available providers
   * @returns Tool execution result
   * @throws Error if provider not found or execution fails
   */
  async executeProviderTool(
    providerId: string,
    toolName: string,
    toolArgs: any,
    userId: string,
    providers: Map<string, ProviderConfig>
  ): Promise<any> {
    const provider = providers.get(providerId);
    if (!provider) {
      throw new Error(`Provider ${providerId} not found`);
    }

    const sessionKey = this.getSessionKey(userId, providerId);
    let sessionId = this.sessions.get(sessionKey);

    if (!sessionId) {
      const token = provider.oauth ? await this.oauthManager.getToken(userId, providerId) : null;
      const tempSessionId = crypto.randomUUID();
      sessionId = await this.initializeSession(provider.mcpUrl, tempSessionId, token);
      this.sessions.set(sessionKey, sessionId);
    }

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
    const result = this.parseResponse(contentType, responseText);

    if (result.error) {
      throw new Error(result.error.message || 'Tool execution failed');
    }

    return result.result;
  }
}

