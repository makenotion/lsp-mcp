#!/usr/bin/env node

import * as protocol from "vscode-languageserver-protocol";
import { startLsp } from "./lsp";
import { startMcp, createMcp } from "./mcp";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getTools } from "./lsp-tools";
import { nullLogger, consoleLogger } from "./logger";
import { Command } from "commander";

async function main(methods: string[] | undefined = undefined, lspCommand: string, verbose: boolean) {
  const tools = await getTools(methods);
  tools.push({
    methodId: "foo",
    name: "file_contents_to_uri",
    description: "Creates a URI given some file contents to be used in the LSP methods that require a URI",
    inputSchema: {
      type: "object" as 'object',
      properties: {
        file_contents: {
          type: "string",
          description: "The contents of the file"
        }
      }
    },
    handler: async (lsp, args) => {
      const { file_contents } = args;
      const uri = `mem://${Math.random().toString(36).substring(2, 15)}`;

      await lsp.sendNotification(protocol.DidOpenTextDocumentNotification.method, {
        textDocument: {
          uri: uri,
          languageId: "typescript",
          version: 1,
          text: file_contents,
        },
      });

      return uri;
    }
  })
  const logger = verbose ? consoleLogger : nullLogger;

  const lsp = await startLsp("sh", [
    "-c",
    lspCommand
  ], logger);

  const toolLookup = new Map(tools.map((tool) => [tool.name, tool]));

  const mcp = createMcp();

  const dispose = async () => {
    lsp.dispose();
    await mcp.close();
  }

  process.on('SIGINT', dispose);
  process.on('SIGTERM', dispose);
  process.on('exit', dispose);

  mcp.setRequestHandler(ListToolsRequestSchema, async () => {
    const mcpTools = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));

    return {
      tools: mcpTools,
    };
  });

  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (!args) {
      throw new Error("No arguments");
    }

    const tool = toolLookup.get(name);
    if (!tool) {
      throw new Error("Unknown tool");
    }

    const result = await tool.handler(lsp, args);

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  });

  await startMcp(mcp);
}

const program = new Command();

program
  .name("lsp-mcp")
  .description("A tool for providing LSP requests to MCP")
  .version("0.1.0")
  .option("-m, --methods [string...]", "LSP methods to enabled (Default: all)")
  .option(
    "-l, --lsp [string]",
    "LSP command to start (note: command is passed through sh -c)",
    // TODO: move this to package.json or something
    `npx -y typescript-language-server --stdio`
  )
  .option("-v, --verbose", "Verbose output (Dev only, don't use with MCP)")
  .parse(process.argv);

const options = program.opts();

main(options.methods, options.lsp, options.verbose);
