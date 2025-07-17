import { spawn } from "node:child_process"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { duplexPair } from "node:stream"
import { v4 as uuid } from "uuid"
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	type MockInstance,
	test,
	vi,
} from "vitest"
import * as rpc from "vscode-jsonrpc"
import { StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node"
import * as protocol from "vscode-languageserver-protocol"
import { errorLogger } from "./logger"
import { LspClientImpl } from "./lsp"
import { flattenJson } from "./utils"

async function sendProgress(
	server_connection: rpc.MessageConnection,
	token: rpc.ProgressToken,
) {
	await server_connection.sendProgress(protocol.WorkDoneProgress.type, token, {
		kind: "begin",
		title: "starting",
	})
	await server_connection.sendProgress(protocol.WorkDoneProgress.type, token, {
		kind: "report",
		message: "middle",
	})
	await server_connection.sendProgress(protocol.WorkDoneProgress.type, token, {
		kind: "end",
		message: "finished",
	})
}
async function sendDiagnostics(
	server_connection: rpc.MessageConnection,
	uri: string,
	diagnostics: protocol.Diagnostic[],
) {
	const token = uuid()
	await server_connection.sendRequest(
		protocol.WorkDoneProgressCreateRequest.type,
		{ token },
	)
	await server_connection.sendProgress(protocol.WorkDoneProgress.type, token, {
		kind: "begin",
		title: "starting",
	})
	await server_connection.sendNotification(
		protocol.PublishDiagnosticsNotification.type,
		{
			uri,
			diagnostics,
		},
	)
	await server_connection.sendProgress(protocol.WorkDoneProgress.type, token, {
		kind: "end",
	})
}
function checkProgress() {
	expect(errorLogger.log).toHaveBeenCalledWith(
		'LSP Progress: {\"kind\":\"begin\",\"title\":\"starting\"}',
	)
	expect(errorLogger.log).toHaveBeenCalledWith(
		'LSP Progress: {\"kind\":\"report\",\"message\":\"middle\"}',
	)
	expect(errorLogger.log).toHaveBeenCalledWith(
		'LSP Progress: {\"kind\":\"end\",\"message\":\"finished\"}',
	)
}
describe("LSP protocol tests", () => {
	let client: LspClientImpl

	let server_connection: rpc.MessageConnection
	const WORKSPACE = "__test_workspace__"
	const SETTINGS = {
		test_setting: "test_value",
		"test.subsection.subsection.value": "other value",
		"test.subsection.subsection.bool": false,
	}
	const EXPECTED_SETTINGS = {
		test_setting: "test_value",
		test: {
			subsection: {
				subsection: {
					value: "other value",
					bool: false,
				},
			},
		},
	}
	let mockSpawn: MockInstance<typeof LspClientImpl.prototype.spawnChildProcess>
	beforeEach(async () => {
		const [pair_a_read, pair_a_write] = duplexPair()
		const [pair_b_read, pair_b_write] = duplexPair()
		const client_connection = rpc.createMessageConnection(
			new StreamMessageReader(pair_a_read),
			new StreamMessageWriter(pair_b_write),
		)
		mockSpawn = vi
			.spyOn(LspClientImpl.prototype, "spawnChildProcess")
			.mockImplementation(async () => {
				return {
					connection: client_connection,
					childProcess: spawn("ls"),
				}
			})
		server_connection = rpc.createMessageConnection(
			new StreamMessageReader(pair_b_read),
			new StreamMessageWriter(pair_a_write),
		)
		server_connection.onRequest(protocol.ShutdownRequest.type, async () => {})
		client = new LspClientImpl(
			"id",
			[],
			["txt"],
			WORKSPACE,
			true,
			false,
			false,
			"",
			[],
			flattenJson(SETTINGS),
			errorLogger,
		)
		try {
			await rm(WORKSPACE, { recursive: true })
		} catch {}
		await mkdir(WORKSPACE)
	})
	test("Initialize is sent", async () => {
		const initialize = new Promise<void>(resolve => {
			server_connection.onRequest(
				protocol.InitializeRequest.type,
				async (params: protocol.InitializeParams) => {
					const URI = `file://${WORKSPACE}`
					expect(params).toMatchObject({
						initializationOptions: EXPECTED_SETTINGS,
						capabilities: expect.any(Object),
						processId: expect.any(Number),
						rootUri: URI,
						workspaceFolders: [expect.objectContaining({ uri: URI })],
						trace: "verbose",
					})
					resolve()
					return {}
				},
			)
		})
		const initialized = new Promise<void>(resolve => {
			server_connection.onNotification(
				protocol.InitializedNotification.type,
				async (params: protocol.InitializedParams) => {
					expect(params).toMatchObject({})
					resolve()
				},
			)
		})
		server_connection.listen()
		expect(client.isStarted()).toBe(false)
		await client.start()
		expect(client.isStarted()).toBe(true)
		await initialize
		expect(mockSpawn).toBeCalledTimes(1)
		await initialized
	})
	test("Configuration Support", async () => {
		server_connection.onRequest(
			protocol.InitializeRequest.type,
			async (params: protocol.InitializeParams) => {
				expect(params.capabilities.workspace?.configuration).toBe(true)
				return {}
			},
		)
		server_connection.onNotification(
			protocol.InitializedNotification.type,
			async (_: protocol.InitializedParams) => {},
		)
		server_connection.listen()
		await client.start()
		const config = await server_connection.sendRequest(
			protocol.ConfigurationRequest.type,
			{ items: [{}] },
		)
		expect(config).toEqual([EXPECTED_SETTINGS])
	})
	test("Progress support", async () => {
		vi.spyOn(errorLogger, "log")
		const initialize = new Promise<void>(resolve => {
			server_connection.onRequest(
				protocol.InitializeRequest.type,
				async (params: protocol.InitializeParams) => {
					const token = params.workDoneToken
					expect(token).toBeDefined()
					expect(token).toBeTruthy()
					if (token !== undefined) {
						await sendProgress(server_connection, token)
					}
					resolve()
					return {}
				},
			)
		})
		const initialized = new Promise<void>(resolve => {
			server_connection.onNotification(
				protocol.InitializedNotification.type,
				async (_: protocol.InitializedParams) => {
					checkProgress()
					resolve()
				},
			)
		})
		server_connection.listen()
		await client.start()
		await initialize
		await initialized
	})
	describe("With Initialized Server", () => {
		const FILE_PATH = `${WORKSPACE}/file.txt`
		const URI = `file:///${FILE_PATH}`
		const ABSOLUTE_URI = `file://${process.cwd()}/${FILE_PATH}`
		beforeEach(async () => {
			server_connection.onRequest(
				protocol.InitializeRequest.type,
				async (_: protocol.InitializeParams) => {
					return {
						capabilities: {
							textDocumentSync: {
								save: true,
							},
						},
					}
				},
			)
			server_connection.onNotification(
				protocol.InitializedNotification.type,
				async (_: protocol.InitializedParams) => {},
			)
			server_connection.listen()
			await client.start()
		})
		test("Update document", async () => {
			const OLD_CONTENT = "old_content"
			const NEW_CONTENT = "new_content"
			const changed = new Promise<void>(resolve => {
				server_connection.onNotification(
					protocol.DidChangeTextDocumentNotification.type,
					async params => {
						expect(params).toEqual({
							contentChanges: [
								{
									text: NEW_CONTENT,
								},
							],
							textDocument: {
								uri: URI,
								version: 2,
							},
						})
						resolve()
					},
				)
			})
			const saved = new Promise<void>(resolve => {
				server_connection.onNotification(
					protocol.DidSaveTextDocumentNotification.type,
					async (params: protocol.DidSaveTextDocumentParams) => {
						expect(params).toEqual({
							textDocument: {
								uri: URI,
							},
							text: NEW_CONTENT,
						})
						resolve()
					},
				)
			})
			const opened = new Promise<void>(resolve => {
				server_connection.onNotification(
					protocol.DidOpenTextDocumentNotification.type,
					async (params: protocol.DidOpenTextDocumentParams) => {
						expect(params).toEqual({
							textDocument: {
								uri: URI,
								languageId: "typescript",
								version: 1,
								text: OLD_CONTENT,
							},
						})
						resolve()
					},
				)
			})
			await client.openFileContents(URI, OLD_CONTENT)
			await opened
			await client.openFileContents(URI, NEW_CONTENT)
			await changed
			await saved
		})

		test("Update document (FS events)", async () => {
			const OLD_CONTENT = "old_content"
			const NEW_CONTENT = "new_content"
			const changed = new Promise<void>(resolve => {
				server_connection.onNotification(
					protocol.DidChangeTextDocumentNotification.type,
					async (params: protocol.DidChangeTextDocumentParams) => {
						expect(params).toEqual({
							contentChanges: [
								{
									text: NEW_CONTENT,
								},
							],
							textDocument: {
								uri: ABSOLUTE_URI,
								version: 2,
							},
						})
						resolve()
					},
				)
			})
			const saved = new Promise<void>(resolve => {
				server_connection.onNotification(
					protocol.DidSaveTextDocumentNotification.type,
					async (params: protocol.DidSaveTextDocumentParams) => {
						expect(params).toEqual({
							textDocument: {
								uri: ABSOLUTE_URI,
							},
							text: NEW_CONTENT,
						})
						resolve()
					},
				)
			})
			const opened = new Promise<void>(resolve => {
				server_connection.onNotification(
					protocol.DidOpenTextDocumentNotification.type,
					async (params: protocol.DidOpenTextDocumentParams) => {
						expect(params).toEqual({
							textDocument: {
								uri: ABSOLUTE_URI,
								languageId: "typescript",
								version: 1,
								text: OLD_CONTENT,
							},
						})
						resolve()
					},
				)
			})
			await writeFile(FILE_PATH, OLD_CONTENT)
			await opened
			await writeFile(FILE_PATH, NEW_CONTENT)
			await changed
			await saved
		})
		test("Shutdown", async () => {
			let shutdown = false
			server_connection.onRequest(protocol.ShutdownRequest.type, async () => {
				shutdown = true
			})
			await client.dispose()
			expect(shutdown).toBe(true)
		})
		test("Progress", async () => {
			vi.spyOn(errorLogger, "log")
			server_connection.onRequest(
				protocol.ReferencesRequest.type,
				async (params: protocol.ReferenceParams) => {
					const token = params.workDoneToken
					expect(token).toBeDefined()
					if (token !== undefined) {
						await sendProgress(server_connection, token)
					}
					return []
				},
			)
			const token = client.registerProgress()
			await client.sendRequest("textDocument/references", {
				workDoneToken: token,
			})
			checkProgress()
		})
		test("Diagnostics", async () => {
			vi.spyOn(errorLogger, "log")
			expect(await client.getDiagnostics()).toEqual([])
			const diagnostic: protocol.Diagnostic = {
				range: {
					start: { line: 1, character: 1 },
					end: { line: 1, character: 1 },
				},
				message: "error",
			}
			// The file needs to be opened to have diagnostics
			await writeFile(FILE_PATH, "testContent")
			await new Promise<void>(resolve =>
				server_connection.onNotification(
					protocol.DidOpenTextDocumentNotification.type,
					(_: protocol.DidOpenTextDocumentParams) => resolve(),
				),
			)
			await sendDiagnostics(server_connection, ABSOLUTE_URI, [diagnostic])
			expect(await client.getDiagnostics()).toEqual([diagnostic])
			// The file needs to be changed to get new diagnostics
			await writeFile(FILE_PATH, "testContent2")
			await new Promise<void>(resolve =>
				server_connection.onNotification(
					protocol.DidChangeTextDocumentNotification.type,
					(_: protocol.DidChangeTextDocumentParams) => resolve(),
				),
			)
			await sendDiagnostics(server_connection, ABSOLUTE_URI, [])
			expect(await client.getDiagnostics()).toEqual([])
		}, 10000)
		test("Logging", async () => {
			vi.spyOn(errorLogger, "log")
			server_connection.sendNotification(protocol.LogMessageNotification.type, {
				message: "Test Message",
				type: protocol.MessageType.Warning,
			})
			await client.dispose()
			expect(errorLogger.log).toHaveBeenCalledWith("LSP: Test Message")
		})
	})
	afterEach(async () => {
		await client.dispose()
		server_connection?.dispose()
		await rm(WORKSPACE, { recursive: true })
	})
})
