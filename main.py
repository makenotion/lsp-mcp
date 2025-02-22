from multilspy import LanguageServer
from multilspy.multilspy_config import MultilspyConfig
from multilspy.multilspy_logger import MultilspyLogger
import os
import asyncio
cwd = os.getcwd()

def get_relative_path(file_path: str) -> str:
    return os.path.join(cwd, file_path)

async def main():
    config = MultilspyConfig.from_dict({"code_language": "python"})
    logger = MultilspyLogger()
    lsp = LanguageServer.create(config, logger, cwd)
    print("LSP starting...")
    async with lsp.start_server():
        print("LSP started")

        path = get_relative_path("main.py")
        with lsp.open_file(get_relative_path(path)):
            result = lsp.get_open_file_text(path)
            print(result)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        print(f"Error: {e}")
        raise e
