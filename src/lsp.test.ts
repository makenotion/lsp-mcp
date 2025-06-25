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
import exp from "constants";
import { error } from "console";
import { version } from "os";
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
					childProcess: spawn("cat"),
				};
			});
		server_connection = rpc.createMessageConnection(
			new StreamMessageReader(pair_b_read),
			new StreamMessageWriter(pair_a_write),
		);
		client = new LspClientImpl(
			"id",
			[],
			[],
			WORKSPACE,
			"",
			[],
			flattenJson(SETTINGS),
			errorLogger,
		);
	});
	test("Initialize is sent", async () => {
		let initialize = false;
		let initialized = false;
		server_connection.onRequest(
			protocol.InitializeRequest.type,
			async (params: protocol.InitializeParams) => {
				expect(params).toMatchObject({
					initializationOptions: EXPECTED_SETTINGS,
					capabilities: expect.any(Object),
					processId: expect.any(Number),
					rootUri: `file://${WORKSPACE}`,
				});

				initialize = true;
				return {};
			},
		);
		server_connection.onNotification(
			protocol.InitializedNotification.type,
			async (params: protocol.InitializedParams) => {
				expect(params).toMatchObject({});
				initialized = true;
			},
		);
		server_connection.listen();
		expect(client.isStarted()).toBe(false);
		await client.start();
		expect(client.isStarted()).toBe(true);
		expect(mockSpawn).toBeCalledTimes(1);
		expect(initialize).toBe(true);
		await new Promise((r) => setTimeout(r, 200));
		expect(initialized).toBe(true);
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
			let changed = false;
			let opened = false;
			let saved = false;
			const URI = "file:///my/test/file";
			const OLD_CONTENT = "old_content";
			const NEW_CONTENT = "new_content";
			server_connection.onNotification(
				protocol.DidChangeTextDocumentNotification.type,
				async (params) => {
					expect(params).toEqual({
						contentChanges: [
							{
								text: NEW_CONTENT,
								range: {
									start: { line: 0, character: 0 },
									end: { line: 0, character: 11 },
								},
							},
						],
						textDocument: {
							uri: URI,
							version: 2,
						},
					});

					changed = true;
				},
			);
			server_connection.onNotification(
				protocol.DidSaveTextDocumentNotification.type,
				async (params) => {
					expect(params).toEqual({
						textDocument: {
							uri: URI,
						},
						text: NEW_CONTENT,
					});

					saved = true;
				},
			);
			server_connection.onNotification(
				protocol.DidOpenTextDocumentNotification.type,
				async (params) => {
					expect(opened).toBe(false); // We shouldn't open the same document twice and instead change it.
					expect(params).toEqual({
						textDocument: {
							uri: URI,
							languageId: "typescript",
							version: 1,
							text: OLD_CONTENT,
						},
					});
					opened = true;
				},
			);
			expect(opened).toBe(false);
			expect(changed).toBe(false);
			expect(saved).toBe(false);
			await client.openFileContents(URI, OLD_CONTENT);
			await new Promise((r) => setTimeout(r, 200));
			expect(opened).toBe(true);
			expect(changed).toBe(false);
			expect(saved).toBe(false);
			await client.openFileContents(URI, NEW_CONTENT);
			expect(opened).toBe(true);
			await new Promise((r) => setTimeout(r, 200));
			expect(changed).toBe(true);
			expect(saved).toBe(true);
		});
	});
	afterEach(() => {
		client.dispose();
		server_connection?.dispose();
	});
});
