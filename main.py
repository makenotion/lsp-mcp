from typing import Callable
from multilspy import LanguageServer
from multilspy.multilspy_config import MultilspyConfig
from multilspy.multilspy_logger import MultilspyLogger
from mcp.server.fastmcp import FastMCP
from mcp.types import (
    Tool as MCPTool,
)
import inspect
import os
import asyncio

cwd = os.getcwd()

def get_relative_path(file_path: str) -> str:
    return os.path.join(cwd, file_path)

def build_mcp(lsp: LanguageServer) -> FastMCP:
    mcp = FastMCP("lsp")
    mcp.add_tool(lsp.request_document_symbols)
    return mcp

def mcp_tool_from_function(fn: Callable) -> MCPTool:
    return MCPTool(
        fn=fn,
        name=fn.__name__,
        description=inspect.getdoc(fn),
    )

async def main():
    config = MultilspyConfig.from_dict({"code_language": "python"})
    logger = MultilspyLogger()
    lsp = LanguageServer.create(config, logger, cwd)

    mcp = build_mcp(lsp)

    print("LSP starting...")
    async with lsp.start_server():
        print("LSP started")

        await mcp.run_stdio_async()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        print(f"Error: {e}")
        raise e
