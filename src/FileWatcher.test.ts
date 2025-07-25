import { mkdir, rm, writeFile } from "node:fs/promises"
import path, { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { FileWatcher } from "./FileWatcher"
import { consoleLogger } from "./logger"
import { pathToFileUri } from "./lsp-methods"

describe("File Watcher tests", () => {
	let watcher: FileWatcher
	const onAdd = vi.fn<(_: string) => Promise<void>>()
	const onChange = vi.fn<(_: string) => Promise<void>>()
	const onRemove = vi.fn<(_: string) => Promise<void>>()
	const testDir = path.resolve("__test__")
	const target = join(testDir, "test.txt")
	const targetUri = pathToFileUri(target)
	beforeEach(async () => {
		try {
			await rm(testDir, { recursive: true })
		} catch (_: unknown) {
			// TODO: fix this
		}
		await mkdir(testDir, {})
		await new Promise(r => setTimeout(r, 300))
		watcher = new FileWatcher(
			[".txt"],
			testDir,
			consoleLogger,
			onChange,
			onRemove,
			onAdd,
		)
		await watcher.start()
	})
	afterEach(async () => {
		await watcher.dispose()
		await rm(testDir, { recursive: true })
		await new Promise(r => setTimeout(r, 300))
	})
	test("Add File", async () => {
		await writeFile(target, "test_Data")
		await expect.poll(() => onAdd).toHaveBeenCalledWith(targetUri)
	})
	test("Update File", async () => {
		await writeFile(target, "test_Data")
		await new Promise(r => setTimeout(r, 300))
		await writeFile(target, "new_Data")
		await expect.poll(() => onChange).toHaveBeenCalledWith(targetUri)
	})
	test("Remove File", async () => {
		await writeFile(target, "test_Data")
		await new Promise(r => setTimeout(r, 300))
		await rm(target)
		await expect.poll(() => onRemove).toHaveBeenCalledWith(targetUri)
	})
})
