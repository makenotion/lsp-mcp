import { ChildProcess, spawn } from "child_process";
import * as rpc from "vscode-jsonrpc";
import { StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import { InitializeRequest } from "vscode-languageserver-protocol";
import * as protocol from "vscode-languageserver-protocol";
import { Logger } from "vscode-jsonrpc";
import path from "path";
import { getLspMethods } from "./lsp-methods";
import { flattenJson } from "./utils";
export interface LspClient {
  id: string;
  languages: string[];
  extensions: string[];
  capabilities: protocol.ServerCapabilities | undefined;
  start(): Promise<void>;
  isStarted(): boolean;
  dispose: () => void;
  sendRequest(method: string, args: any): Promise<any>;
  sendNotification(method: string, args: any): Promise<void>;
}

export class LspClientImpl implements LspClient {
  protected childProcess: ChildProcess | undefined;

  protected connection: rpc.MessageConnection | undefined;

  public capabilities: protocol.ServerCapabilities | undefined;

  public constructor(
    public readonly id: string,
    public readonly languages: string[],
    public readonly extensions: string[],
    public readonly workspace: string,
    private readonly command: string,
    private readonly args: string[],
    private readonly settings: object,
    private readonly logger: Logger, // TODO: better long term solution for logging
  ) {
    this.capabilities = undefined;
  }

  public async start() {
    // TODO: This should return a promise if the LSP is still starting
    // Just don't call start() twice and it'll be fine :)
    if (this.isStarted()) {
      return;
    }

    const childProcess = (this.childProcess = spawn(this.command, this.args));

    if (!childProcess.stdout || !childProcess.stdin) {
      throw new Error("Child process not started");
    }

    const connection = (this.connection = rpc.createMessageConnection(
      new StreamMessageReader(childProcess.stdout),
      new StreamMessageWriter(childProcess.stdin),
      this.logger,
    ));
    connection.onError((error) => {
      this.logger.error(`Connection error: ${error}`);
      childProcess.kill();
    });

    connection.onClose(() => {
      this.logger.log("Connection closed");
      childProcess.kill();
    });
    connection.onRequest(
      protocol.ConfigurationRequest.type,
      ({ items }: protocol.ConfigurationParams) => {
        this.logger.log(
          `LSP: Configuration request for ${items.length} items ${JSON.stringify(items)}`,
        );
        const response = items.map((element) => {
          return this.settings;
        });
        this.logger.log(
          `LSP: Configuration response for ${items.length} items ${JSON.stringify(response)}`,
        );
        return response;
      },
    );
    connection.onNotification(
      protocol.LogMessageNotification.type,
      ({ message }) => {
        this.logger.log(`LSP: ${message}`);
      },
    );
    connection.onRequest(protocol.ShowMessageRequest.type, (request) => {
      this.logger.log(`Unhandled request: ${JSON.stringify(request)}`);
    });
    connection.onUnhandledNotification((notification) => {
      this.logger.log(
        `Unhandled notification: ${JSON.stringify(notification)}`,
      );
    });

    connection.listen();

    // TODO: We should figure out how to specify the capabilities we want
    let capabilities: protocol.ClientCapabilities = {
      workspace: {
        configuration: true,
      },
    };
    const methods = await getLspMethods();
    for (const method of methods) {
      if (method.capability) {
        capabilities[method.capability] = true;
      }
    }
    capabilities = flattenJson(capabilities);
    const uri = `file://${this.workspace}`;
    const response = await connection.sendRequest(InitializeRequest.type, {
      processId: process.pid,
      rootUri: uri,
      capabilities: capabilities,
      initializationOptions: this.settings,
    });
    this.logger.log(
      `LSP init options ${JSON.stringify(this.settings, null, 2)}`,
    );

    this.logger.info(
      `Client LSP capabilities: ${JSON.stringify(capabilities, null, 2)}`,
    );

    this.logger.info(
      `Server LSP capabilities: ${JSON.stringify(response, null, 2)}`,
    );
    this.capabilities = response.capabilities;
    await connection.sendNotification(
      protocol.InitializedNotification.type,
      {},
    );
  }

  public isStarted(): this is LspClientImpl & {
    connection: rpc.MessageConnection;
  } {
    return !!this.connection;
  }

  private assertStarted(): asserts this is LspClientImpl & {
    connection: rpc.MessageConnection;
  } {
    if (!this.connection) {
      throw new Error("Not started");
    }
  }

  async sendRequest(method: string, args: any): Promise<any> {
    if (!this.isStarted()) {
      await this.start();
    }

    this.assertStarted();

    return await this.connection.sendRequest(method, args);
  }

  async sendNotification(method: string, args: any): Promise<void> {
    if (!this.isStarted()) {
      await this.start();
    }

    this.assertStarted();

    return await this.connection.sendNotification(method, args);
  }

  dispose() {
    try {
      this.connection?.dispose();
      this.childProcess?.kill();
    } catch (e: any) {
      this.logger.error(e.toString?.());
    }
  }
}
