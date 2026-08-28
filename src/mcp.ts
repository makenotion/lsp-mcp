import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { PACKAGE_VERSION } from "./version";

// Create an MCP server
export function createMcp(instructions?: string): McpServer {
  return new McpServer(
    {
      name: "LSP",
      version: PACKAGE_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
      instructions
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
