from multilspy import LanguageServer
from multilspy.multilspy_config import MultilspyConfig
from multilspy.multilspy_logger import MultilspyLogger
import os
import asyncio

async def main():
    cwd = os.getcwd()
    config = MultilspyConfig.from_dict({"code_language": "python"})
    logger = MultilspyLogger()
    lsp = LanguageServer.create(config, logger, cwd)
    print("LSP starting...")
    async with lsp.start_server():
        print("LSP started")

        try:
            result = await lsp.request_definition("main.py", 7, 5)
            print(result)
        except Exception as e:
            print(f"Error getting definition: {e}")


if __name__ == "__main__":
    asyncio.run(main())
