import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type ParcelWatcher from "@parcel/watcher"
import watcher, { type Event } from "@parcel/watcher"
import type { Logger } from "vscode-jsonrpc"
import { pathToFileUri } from "./lsp-methods"

async function readGitIgnore(
	logger: Logger,
	workspaceRoot: string,
): Promise<string[]> {
	try {
		const contents = await readFile(join(workspaceRoot, ".gitignore"), "utf-8")
		return contents
			.split("\n")
			.filter(
				line =>
					line.trim() !== "" && !line.startsWith("#") && !line.startsWith("!"), // Negated patterns don't work.
			)
			.map(pattern => (pattern.startsWith("/") ? pattern.slice(1) : pattern))
	} catch (e: unknown) {
		if (e instanceof Error) {
			logger.error(e.stack || e.toString?.())
		}
		return []
	}
}
export class FileWatcher {
	private watcher: ParcelWatcher.AsyncSubscription | undefined
	private events: Event[]
	private resolveNext: (() => void) | undefined = undefined
	private cancelled: boolean = false
	private poll: Promise<void> | undefined = undefined
	constructor(
		private readonly extensions: string[],
		private readonly root: string,
		private readonly logger: Logger,
		private readonly onFileChanged: (uri: string) => Promise<void>,
		private readonly onFileRemoved: (uri: string) => Promise<void>,
		private readonly onFileCreated: (uri: string) => Promise<void>,
	) {
		this.events = []
	}
	queueEvents(events: Event[]) {
		for (const fs_event of events) {
			if (!this.extensions.some(ext => fs_event.path.endsWith(ext))) {
				continue
			}
			this.logger.info(`Event: ${fs_event.type} ${fs_event.path}`)
			this.events.push(fs_event)
		}
		if (this.resolveNext !== undefined) {
			this.resolveNext()
			this.resolveNext = undefined
		}
	}
	async pollEvents() {
		while (this.cancelled === false) {
			if (this.events.length > 0) {
				const events = this.events
				this.events = []
				await Promise.all(
					events.map(async ({ type, path }) => {
						const uri = pathToFileUri(path)
						switch (type) {
							case "update":
								if (!events.some(e => e.type === "create" && e.path === path)) {
									await this.onFileChanged(uri)
								}
								break
							case "create":
								await this.onFileCreated(uri)
								break
							case "delete":
								await this.onFileRemoved(uri)
								break
						}
					}),
				)
			}
			const { promise, resolve, reject: _ } = Promise.withResolvers<void>()
			this.resolveNext = resolve
			await promise
			// In CI, the watcher may register a create as a create and change. This gives us a little bit of room to catch these cases.
			await new Promise(resolve => setTimeout(resolve, 100))
		}
	}
	async start() {
		this.logger.info(`Reading gitignore from ${this.root}`)
		const gitignore = await readGitIgnore(this.logger, this.root)
		this.logger.info(
			`Starting file watcher for ${JSON.stringify(this.root)} with extensions ${JSON.stringify(this.extensions)}`,
		)
		this.logger.info(`gitignore: ${JSON.stringify(gitignore, null, 2)}`)
		this.watcher = await watcher.subscribe(
			this.root,
			(err, events: Event[]) => {
				if (err !== null) {
					this.logger.error(`Watcher error: ${err}`)
				}
				this.queueEvents(events)
			},
			{
				ignore: gitignore,
			},
		)
		this.logger.info("Started file watcher")
		this.poll = this.pollEvents()
	}
	async dispose() {
		this.cancelled = true
		if (this.resolveNext !== undefined) {
			this.resolveNext()
		}
		if (this.poll !== undefined) {
			await this.poll
		}
		await this.watcher?.unsubscribe()
	}
}
