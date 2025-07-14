import {
	beforeEach,
	describe,
	test,
	afterEach,
	jest,
	expect,
} from "@jest/globals";
import * as rpc from "vscode-jsonrpc";
import { StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import { duplexPair } from "stream";
import { LspClientImpl } from "./lsp";
import { errorLogger, nullLogger } from "./logger";
import * as protocol from "vscode-languageserver-protocol";
import { spawn } from "child_process";
import { flattenJson } from "./utils";
import {
	WorkDoneProgressBegin,
	WorkDoneProgressEnd,
	WorkDoneProgressReport,
} from "vscode-languageserver-protocol";
import exp from "constants";
import { error } from "console";

async function sendProgress(
	server_connection: rpc.MessageConnection,
	token: rpc.ProgressToken,
) {
	await server_connection.sendProgress(protocol.WorkDoneProgress.type, token, {
		kind: "begin",
		title: "starting",
	});
	await server_connection.sendProgress(protocol.WorkDoneProgress.type, token, {
		kind: "report",
		message: "middle",
	});
	await server_connection.sendProgress(protocol.WorkDoneProgress.type, token, {
		kind: "end",
		message: "finished",
	});
}
function checkProgress() {
	expect(errorLogger.log).toHaveBeenCalledWith(
		'LSP Progress: {\"kind\":\"begin\",\"title\":\"starting\"}',
	);
	expect(errorLogger.log).toHaveBeenCalledWith(
		'LSP Progress: {\"kind\":\"report\",\"message\":\"middle\"}',
	);
	expect(errorLogger.log).toHaveBeenCalledWith(
		'LSP Progress: {\"kind\":\"end\",\"message\":\"finished\"}',
	);
}
describe("LSP protocol tests", () => {
	let client: LspClientImpl;

	let server_connection: rpc.MessageConnection;
	const WORKSPACE = "my/test/workspace";
	const SETTINGS = {
		test_setting: "test_value",
		"test.subsection.subsection.value": "other value",
		"test.subsection.subsection.bool": false,
	};
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
	};
	let mockSpawn: jest.SpiedFunction<
		typeof LspClientImpl.prototype.spawnChildProcess
	>;
	beforeEach(() => {
		const [pair_a_read, pair_a_write] = duplexPair();
		const [pair_b_read, pair_b_write] = duplexPair();
		const client_connection = rpc.createMessageConnection(
			new StreamMessageReader(pair_a_read),
			new StreamMessageWriter(pair_b_write),
		);
		mockSpawn = jest
			.spyOn(LspClientImpl.prototype, "spawnChildProcess")
			.mockImplementation(async () => {
				return {
					connection: client_connection,
					childProcess: spawn("ls"),
				};
			});
		server_connection = rpc.createMessageConnection(
			new StreamMessageReader(pair_b_read),
			new StreamMessageWriter(pair_a_write),
		);
		server_connection.onRequest(protocol.ShutdownRequest.type, async () => {});
		client = new LspClientImpl(
			"id",
			[],
			[],
			WORKSPACE,
			true,
			"",
			[],
			flattenJson(SETTINGS),
			errorLogger,
		);
	});
	test("Initialize is sent", async () => {
		const initialize = new Promise<void>((resolve) => {
			server_connection.onRequest(
				protocol.InitializeRequest.type,
				async (params: protocol.InitializeParams) => {
					expect(params).toMatchObject({
						initializationOptions: EXPECTED_SETTINGS,
						capabilities: expect.any(Object),
						processId: expect.any(Number),
						rootUri: `file://${WORKSPACE}`,
					});
					resolve();
					return {};
				},
			);
		});
		const initialized = new Promise<void>((resolve) => {
			server_connection.onNotification(
				protocol.InitializedNotification.type,
				async (params: protocol.InitializedParams) => {
					expect(params).toMatchObject({});
					resolve();
				},
			);
		});
		server_connection.listen();
		expect(client.isStarted()).toBe(false);
		await client.start();
		expect(client.isStarted()).toBe(true);
		await initialize;
		expect(mockSpawn).toBeCalledTimes(1);
		await initialized;
	});
	test("Configuration Support", async () => {
		server_connection.onRequest(
			protocol.InitializeRequest.type,
			async (params: protocol.InitializeParams) => {
				expect(params.capabilities.workspace?.configuration).toBe(true);
				return {};
			},
		);
		server_connection.onNotification(
			protocol.InitializedNotification.type,
			async (_: protocol.InitializedParams) => {},
		);
		server_connection.listen();
		await client.start();
		const config = await server_connection.sendRequest(
			protocol.ConfigurationRequest.type,
			{ items: [{}] },
		);
		expect(config).toEqual([EXPECTED_SETTINGS]);
	});
	test("Progress support", async () => {
		jest.spyOn(errorLogger, "log");
		const initialize = new Promise<void>((resolve) => {
			server_connection.onRequest(
				protocol.InitializeRequest.type,
				async (params: protocol.InitializeParams) => {
					const token = params.workDoneToken;
					expect(token).toBeDefined();
					expect(token).toBeTruthy();
					if (token !== undefined) {
						await sendProgress(server_connection, token);
					}
					resolve();
					return {};
				},
			);
		});
		const initialized = new Promise<void>((resolve) => {
			server_connection.onNotification(
				protocol.InitializedNotification.type,
				async (_: protocol.InitializedParams) => {
					checkProgress();
					resolve();
				},
			);
		});
		server_connection.listen();
		await client.start();
		await initialize;
		await initialized;
	});
	describe("With Initialized Server", () => {
		beforeEach(async () => {
			server_connection.onRequest(
				protocol.InitializeRequest.type,
				async (params: protocol.InitializeParams) => {
					return { capabilities: {} };
				},
			);
			server_connection.onNotification(
				protocol.InitializedNotification.type,
				async (_: protocol.InitializedParams) => {},
			);
			server_connection.listen();
			await client.start();
		});
		test("Update document", async () => {
			const URI = "file:///my/test/file";
			const OLD_CONTENT = "old_content";
			const NEW_CONTENT = "new_content";
			const changed = new Promise<void>((resolve) => {
				server_connection.onNotification(
					protocol.DidChangeTextDocumentNotification.type,
					async (params) => {
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
						});
						resolve();
					},
				);
			});
			const saved = new Promise<void>((resolve) => {
				server_connection.onNotification(
					protocol.DidSaveTextDocumentNotification.type,
					async (params) => {
						expect(params).toEqual({
							textDocument: {
								uri: URI,
							},
							text: NEW_CONTENT,
						});
						resolve();
					},
				);
			});
			const opened = new Promise<void>((resolve) => {
				server_connection.onNotification(
					protocol.DidOpenTextDocumentNotification.type,
					async (params) => {
						expect(params).toEqual({
							textDocument: {
								uri: URI,
								languageId: "typescript",
								version: 1,
								text: OLD_CONTENT,
							},
						});
						resolve();
					},
				);
			});
			await client.openFileContents(URI, OLD_CONTENT);
			await opened;
			await client.openFileContents(URI, NEW_CONTENT);
			await changed;
			await saved;
		});

		test("Shutdown", async () => {
			let shutdown = false;
			server_connection.onRequest(protocol.ShutdownRequest.type, async () => {
				shutdown = true;
			});
			await client.dispose();
			expect(shutdown).toBe(true);
		});
		test("Progress", async () => {
			jest.spyOn(errorLogger, "log");
			server_connection.onRequest(
				protocol.ReferencesRequest.type,
				async (params) => {
					let token = params.workDoneToken;
					expect(token).toBeDefined();
					if (token !== undefined) {
						await sendProgress(server_connection, token);
					}
					return [];
				},
			);
			const token = client.registerProgress();
			await client.sendRequest("textDocument/references", {
				workDoneToken: token,
			});
			checkProgress();
		});
	});
	afterEach(async () => {
		await client.dispose();
		server_connection?.dispose();
	});
});
