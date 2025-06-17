import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

// Create an MCP server
export function createMcp(): McpServer {
  return new McpServer(
    {
      name: "LSP",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );
}

// Start receiving messages on stdin and sending messages on stdout
export async function startMcp(
  mcp: McpServer,
  transport: Transport = new StdioServerTransport(),
) {
  await mcp.connect(transport);
}
