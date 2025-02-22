# MCP LSP POC
## The ABCs (Introduction)
### What is an MCP?
### What is an LSP?
## Development
### Dependencies
* [uv](https://docs.astral.sh/uv/)
### Running
### Testing
### Debugging
## Decisions
* Using python - I want to leverage a client library that makes the startup of this simple. A lot of LSPs are created in node, but the mature client libraries seem to be dependent on vscode. I like the look of [multilspy](https://github.com/microsoft/multilspy), so we'll start with python. It helps that I already created a python MCP, so at least I'll have a leg up there
* [uv](https://docs.astral.sh/uv/)  for package management and such - I've been seeing this used more frequently lately and this is an excuse to learn it. Switching package managers in the future is annoying but doable. I may have to revisit this decision once implementing CI/CD. Maybe I can use this instead of a dependency on [taskfile](https://taskfile.dev/) as well? TBD
* Async when possible - It's 2025
