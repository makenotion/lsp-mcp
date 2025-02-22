from multilspy import SyncLanguageServer
from multilspy.multilspy_config import MultilspyConfig
from multilspy.multilspy_logger import MultilspyLogger
import os
import asyncio

def main():
    cwd = os.getcwd()
    config = MultilspyConfig.from_dict({"code_language": "python"})
    logger = MultilspyLogger()
    lsp = SyncLanguageServer.create(config, logger, cwd)
    print("LSP starting...")
    with lsp.start_server():
        print("LSP started")

        try:
            result = lsp.request_definition("main.py", 6, 5)
            print(result)
        except Exception as e:
            print(f"Error getting definition: {e}")


if __name__ == "__main__":
    main()
