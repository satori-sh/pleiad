import type { PleiadesConfig } from './types.js';

/**
 * MCP protocol handlers
 * 
 * These functions handle MCP protocol methods (initialize, tools/list, tools/call, etc.)
 * They return JSON-RPC 2.0 compliant responses. Consumed by routes.ts which dispatches
 * requests to the appropriate handler based on the 'method' field.
 */

/**
 * Handle MCP initialize protocol method
 * 
 * Required by MCP protocol spec. Called when an MCP client connects to /mcp endpoint.
 * Advertises server capabilities so client knows what operations are available.
 * 
 * Note: protocolVersion, capabilities, and version are server metadata - they describe
 * what this Pleiades instance can do, not what the client should do.
 * 
 * @param config - Pleiades server configuration
 * @param requestId - JSON-RPC request ID
 * @returns Server capabilities and version info
 */
export function handleInitialize(config: PleiadesConfig, requestId: number | string) {
  return {
    jsonrpc: '2.0',
    id: requestId,
    result: {
      protocolVersion: '2025-06-18',
      capabilities: {
        tools: { listChanged: true },
        prompts: { listChanged: true },
        resources: { listChanged: true }
      },
      serverInfo: {
        name: config.name,
        version: '0.1.0'
      }
    }
  };
}

/**
 * Handle MCP tools/list protocol method
 * Returns individual tools for each configured provider (e.g., 'use_linear', 'use_sentry')
 * @param providers - Available provider configurations
 * @param requestId - JSON-RPC request ID
 * @returns List of provider-specific tools
 */
export function handleToolsList(requestId: number | string) {
  return {
    jsonrpc: '2.0',
    id: requestId,
    result: {
      tools: [
        {
          name: 'use_pleiades',
          description: 'Intelligently route a natural language request to one or more providers and tools.',
          inputSchema: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'Natural language request describing what you want to do' }
            },
            required: ['prompt']
          }
        }
      ]
    }
  };
}

/**
 * Handle MCP tools/call protocol method
 * Routes provider-specific tools (e.g., 'use_linear') to AI agent
 * @param toolName - Name of the tool being called (e.g., 'use_linear', 'use_sentry')
 * @param args - Tool arguments
 * @param userId - User identifier
 * @param requestId - JSON-RPC request ID
 * @param providers - Available provider configurations
 * @param agentHandler - Callback to execute the agent with the provided args and provider
 * @returns Agent result or error for unknown tools
 */
export function handleToolsCall(
  toolName: string,
  args: { prompt: string },
  userId: string,
  requestId: number | string,
  providers: Map<string, any>,
  agentHandler: (args: { prompt: string }, userId: string, requestId: number | string) => Promise<any>
) {
  if (toolName !== 'use_pleiades') {
    return {
      jsonrpc: '2.0',
      id: requestId,
      error: { code: -32602, message: `Unknown tool: ${toolName}` }
    };
  }

  return agentHandler({ ...args }, userId, requestId);
}

/**
 * Handle MCP prompts/list protocol method
 * @param requestId - JSON-RPC request ID
 * @returns Empty prompts list
 */
export function handlePromptsList(requestId: number | string) {
  return {
    jsonrpc: '2.0',
    id: requestId,
    result: { prompts: [] }
  };
}

/**
 * Handle MCP resources/list protocol method
 * @param requestId - JSON-RPC request ID
 * @returns Empty resources list
 */
export function handleResourcesList(requestId: number | string) {
  return {
    jsonrpc: '2.0',
    id: requestId,
    result: { resources: [] }
  };
}

