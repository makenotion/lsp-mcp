import { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { JSONSchema4 } from "json-schema";
import { Logger } from "vscode-languageserver-protocol";

export interface Tool {
  id: string;
  description: string;
  inputSchema: JSONSchema4;
  handler: (args: Record<string, any>, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => Promise<string>;
}

export class ToolManager {
  private toolsById: Map<string, Tool> = new Map();

  constructor(private readonly logger: Logger) { }

  public registerTool(tool: Tool): void {
    this.toolsById.set(tool.id, tool);
  }

  public async callTool(id: string, args: Record<string, any>, extra: RequestHandlerExtra<ServerRequest, ServerNotification>): Promise<string> {
    const tool = this.getTool(id);
    if (!tool) {
      throw new Error(`Tool ${id} not found`);
    }
    return tool.handler(args, extra);
  }

  public getTools(): Tool[] {
    return Array.from(this.toolsById.values());
  }

  private getTool(id: string): Tool | undefined {
    return this.toolsById.get(id);
  }
}

