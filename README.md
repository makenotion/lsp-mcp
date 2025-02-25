# LSP MCP
An Model Context Protocol (MCP) server that provides LLMs/AI Agents with the capabilities of a language server protocol (LSP) server. This gives the AI the ability to get language aware context from the codebase.

## Warning
This is in a POC state.

## Quick Start
### Claude AI
Modify `claude_desktop_config.json` (As described in the [MCP Docs](https://modelcontextprotocol.io/quickstart/user#2-add-the-filesystem-mcp-server)) with the following:
```
{
  "mcpServers": {
    "lsp": {
      "command": "npx",
      "args": ["-y", "git+https://github.com/jonrad/lsp-mcp", "--lsp", "npx -y -p 'typescript@5.7.3' -p 'typescript-language-server@4.3.3' typescript-language-server --stdio"]
    }
  }
}
```

This will provide Claude with the LSP capabilities of the typescript language server. You can modify the language server by switching the `--lsp` argument (and then restarting Claude).

Multiple LSPs at the same time is not yet supported.

### [MCP CLI Client](https://github.com/adhikasp/mcp-client-cli)
Follow the instructions for Claude but the config file is located in `~/.llm/config.json`


## The ABCs (Introduction)
### What is an MCP?
* [MCP](https://modelcontextprotocol.io/) - Documentation
* [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk) - MCP Server Python Library
### What is an LSP?
* [LSP](https://microsoft.github.io/language-server-protocol/) - Documentation
* [multilspy](https://github.com/microsoft/multilspy) - LSP Python Client Library
## Development
```bash
yarn
yarn mcp-cli # Interactive MCP tool to help with development
yarn dev --help # Get the CLI help
```
### Dependencies
### Decisions
* ~~Using python - I want to leverage a client library that makes the startup of this simple. A lot of LSPs are created in node, but the mature client libraries seem to be dependent on vscode. I like the look of [multilspy](https://github.com/microsoft/multilspy), so we'll start with python. It helps that I already created a python MCP, so at least I'll have a leg up there~~
* ~~[uv](https://docs.astral.sh/uv/)  for package management and such - I've been seeing this used more frequently lately and this is an excuse to learn it. Switching package managers in the future is annoying but doable. I may have to revisit this decision once implementing CI/CD. Maybe I can use this instead of a dependency on [taskfile](https://taskfile.dev/) as well? TBD~~
* Async when possible - It's 2025
* Switching to node after all. POC with python was more successful than I expected. But, multilspy doesn't support the entire LSP spec and vscode's library will be easier to work with as node is arguably the defacto standard language of LSP servers/clients.
* Using the low-level MCP SDK. I think I'll need more control and it's frankly not that complicated as compared to the higher level FastMCP.

### Roadmap
This is just a list of things I'd like to do eventually. There is no timeline or order for these.
* Multiple LSPs at the same time
* Docker image with all the LSPs pre-installed
* Figure out how to sync capabilities between the LSP client (this) and the LSP server
* Auto generated the LSP JSON Schema or find where it's published
* Make json schema a cli argument so we don't have the update code to support new ones
* Connect to an already running LSP server (via a multiplexing LSP server?)
* Switch to (Taskfile)[https://taskfile.dev/]

## References
* [Generated LSP JSON Schema](https://gist.github.com/bollwyvl/7a128978b8ae89ab02bbd5b84d07a4b7#file-generated-protocol-schema-json)
