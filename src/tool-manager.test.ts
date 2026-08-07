import { describe, expect, test } from "vitest"
import { ToolManager } from "./tool-manager"

const logger = { error() {}, warn() {}, info() {}, log() {} }
const tool = (id: string) => ({
	id,
	description: "",
	inputSchema: {},
	handler: async () => id,
})

const extra = {} as Parameters<ToolManager["callTool"]>[2]

describe("ToolManager", () => {
	test("Tools are renamed via toolNames", async () => {
		const manager = new ToolManager(logger, { lsp_info: "renamed" })
		manager.registerTool(tool("lsp_info"))
		manager.registerTool(tool("get_diagnostics"))
		expect(manager.getTools().map(t => t.id)).toEqual([
			"renamed",
			"get_diagnostics",
		])
		expect(await manager.callTool("renamed", {}, extra)).toBe("lsp_info")
		await expect(manager.callTool("lsp_info", {}, extra)).rejects.toThrow()
	})
})
