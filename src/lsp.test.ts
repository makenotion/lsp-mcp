import { beforeEach, describe, test, afterEach , jest, expect } from "@jest/globals";
import * as rpc from "vscode-jsonrpc";
import { StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import { duplexPair } from "stream";
import { LspClientImpl } from "./lsp";
import { nullLogger } from "./logger";
import * as protocol from "vscode-languageserver-protocol";
import { spawn } from "child_process";
import { flattenJson } from "./utils";
describe("LSP protocol tests", () => {
  let client: LspClientImpl;

  let server_connection: rpc.MessageConnection
  const WORKSPACE = "my/test/workspace"
  const SETTINGS = {
      "test_setting": "test_value",
      "test.subsection.subsection.value": "other value",
      "test.subsection.subsection.bool": false
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
  };
  let mockSpawn: jest.SpiedFunction<typeof LspClientImpl.prototype.spawnChildProcess>
  beforeEach(() => {
    const [pair_a_read, pair_a_write] = duplexPair()
    const [pair_b_read, pair_b_write] = duplexPair()
    const client_connection = rpc.createMessageConnection(
      new StreamMessageReader(pair_a_read),
      new StreamMessageWriter(pair_b_write),
    )
    mockSpawn = jest.spyOn(LspClientImpl.prototype, "spawnChildProcess").mockImplementation(async () => {return {connection: client_connection, childProcess: spawn("true") }})
    server_connection = rpc.createMessageConnection(
      new StreamMessageReader(pair_b_read),
      new StreamMessageWriter(pair_a_write),
    )
    client = new LspClientImpl(
      "id",
      [],
      [],
      WORKSPACE,
      "",
      [],
      flattenJson(SETTINGS),
      nullLogger
    )

  })
  test("Initialize is sent", async ()=> {
    let initialize = false
    let initialized = false
    server_connection.onRequest(protocol.InitializeRequest.type, async (params: protocol.InitializeParams) => {
      expect(params).toMatchObject({initializationOptions: EXPECTED_SETTINGS, capabilities: expect.any(Object), processId: expect.any(Number),rootUri: `file://${WORKSPACE}`})

      initialize = true
      return {}
    })
    server_connection.onNotification(protocol.InitializedNotification.type, async (params: protocol.InitializedParams) => {
      expect(params).toMatchObject({})
      initialized = true
    })
    server_connection.listen()
    const client_spawn = client.start()
    expect(mockSpawn).toBeCalledTimes(1)

    await client_spawn
    expect(initialize).toBe(true)
    await new Promise((r) => setTimeout(r, 2000));
    expect(initialized).toBe(true)
  })
  test("Configuration Support",async () => {
    server_connection.onRequest(protocol.InitializeRequest.type, async (params: protocol.InitializeParams) => {
      expect(params.capabilities.workspace?.configuration).toBe(true)
      return {}
    })
    server_connection.onNotification(protocol.InitializedNotification.type, async (_: protocol.InitializedParams) => {
    })
    server_connection.listen()
    await client.start()
    const config = await server_connection.sendRequest(protocol.ConfigurationRequest.type, { items: [{  }] })
    expect(config).toEqual([EXPECTED_SETTINGS])
  })
  afterEach(() => {
    client.dispose();
    server_connection?.dispose();
  })
})
