import { beforeEach, afterEach, test, describe, expect, vi } from "vitest";
import { FileWatcher } from "./FileWatcher";
import { consoleLogger } from "./logger";
import path, { join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { pathToFileUri } from "./lsp-methods";

describe("File Watcher tests", () => {
	let watcher: FileWatcher;
	const onAdd = vi.fn<(_: string, __: string) => Promise<void>>();
	const onChange = vi.fn<(_: string, __: string) => Promise<void>>();
	const onRemove = vi.fn<(_: string) => Promise<void>>();
	const testDir = path.resolve("__test__");
	const target = join(testDir, "test.txt");
	const targetUri = pathToFileUri(target);
	beforeEach(async () => {
		try {
			await rm(testDir, { recursive: true });
		} catch (e: unknown) {
			// TODO: fix this
		}
		await mkdir(testDir, {});
		await new Promise((r) => setTimeout(r, 300));
		watcher = new FileWatcher(
			[".txt"],
			testDir,
			consoleLogger,
			onChange,
			onRemove,
			onAdd,
		);
		await watcher.start();
	});
	afterEach(async () => {
		await watcher.dispose();
		await rm(testDir, { recursive: true });
		await new Promise((r) => setTimeout(r, 300));
	});
	test("Add File", async () => {
		await writeFile(target, "test_Data");
		await new Promise((r) => setTimeout(r, 300));
		expect(onAdd).toHaveBeenCalledWith(targetUri, "test_Data");
	});
	test("Update File", async () => {
		await writeFile(target, "test_Data");
		await new Promise((r) => setTimeout(r, 300));
		await writeFile(target, "new_Data");
		await new Promise((r) => setTimeout(r, 300));
		expect(onChange).toHaveBeenCalledWith(targetUri, "new_Data");
	});
	test("Remove File", async () => {
		await writeFile(target, "test_Data");
		await new Promise((r) => setTimeout(r, 300));
		await rm(target);
		await new Promise((r) => setTimeout(r, 300));
		expect(onRemove).toHaveBeenCalledWith(targetUri);
	});
});
