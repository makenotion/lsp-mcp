import type { Implementation } from "@modelcontextprotocol/sdk/types.js";

// Required rather than imported so package.json stays out of the compiled output tree
function readPackageJson(): { name: string; version: string } {
  for (const candidate of ["../package.json", "./package.json"]) {
    try {
      return require(candidate);
    } catch {
      // Try the next layout
    }
  }
  return { name: "lsp-mcp", version: "unknown" };
}

const pkg = readPackageJson();

export const PACKAGE_NAME: string = pkg.name;
export const PACKAGE_VERSION: string = pkg.version;

// Identifies the agent driving us, with this library noted in the name
export function buildClientInfo(agent?: Implementation): { name: string; version: string } {
  if (!agent) {
    return { name: PACKAGE_NAME, version: PACKAGE_VERSION };
  }

  return {
    name: `${agent.name} (${PACKAGE_NAME} ${PACKAGE_VERSION})`,
    version: agent.version || "unknown",
  };
}
