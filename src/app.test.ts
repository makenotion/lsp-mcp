import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { Diagnostic } from "vscode-languageserver-protocol"
import { DIAGNOSTICS_TIMEOUT_MS, getDiagnosticsWithTimeout } from "./app"

const diagnostic: Diagnostic = {
	range: {
		start: { line: 0, character: 0 },
		end: { line: 0, character: 1 },
	},
	message: "Type error",
}

describe("getDiagnosticsWithTimeout", () => {
	const logger = { error: vi.fn(), warn() {}, info() {}, log() {} }

	beforeEach(() => {
		vi.useFakeTimers()
		logger.error.mockClear()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	test("A fast response does not log a timeout later", async () => {
		const lsp = { getDiagnostics: async () => [diagnostic] }

		expect(await getDiagnosticsWithTimeout(lsp, "a.ts", logger)).toEqual([
			diagnostic,
		])
		await vi.advanceTimersByTimeAsync(DIAGNOSTICS_TIMEOUT_MS)

		expect(logger.error).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})

	test("A slow response returns empty and logs the timeout", async () => {
		const lsp = { getDiagnostics: () => new Promise<Diagnostic[]>(() => {}) }

		const result = getDiagnosticsWithTimeout(lsp, "a.ts", logger)
		await vi.advanceTimersByTimeAsync(DIAGNOSTICS_TIMEOUT_MS)

		expect(await result).toEqual([])
		expect(logger.error).toHaveBeenCalledWith(
			"Getting diagnostics timed out, returning empty result",
		)
	})

	test("A failed request clears the timer", async () => {
		const lsp = {
			getDiagnostics: async (): Promise<Diagnostic[]> => {
				throw new Error("Connection is closed.")
			},
		}

		await expect(getDiagnosticsWithTimeout(lsp, "a.ts", logger)).rejects.toThrow(
			"Connection is closed.",
		)
		expect(vi.getTimerCount()).toBe(0)
	})
})
