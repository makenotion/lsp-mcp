import { ChildProcess, spawn } from "child_process";
import * as rpc from "vscode-jsonrpc";
import { StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import { InitializeRequest, WorkDoneProgressBegin, WorkDoneProgressEnd, WorkDoneProgressReport } from "vscode-languageserver-protocol";
import * as protocol from "vscode-languageserver-protocol";
import { Logger } from "vscode-jsonrpc";
import { v4 as uuid } from 'uuid';
import { ProgressNotification } from "@modelcontextprotocol/sdk/types.js";
import { convertLspToMcp } from "./progress";
import { readFile } from "fs/promises";
import { FileWatcher } from "./FileWatcher";
import { setTimeout } from "timers/promises";
import { readFileSync } from "fs";

export interface LspClient {
  id: string;
  languages: string[];
  extensions: string[];
  eagerStartup: boolean;
  capabilities: protocol.ServerCapabilities | undefined;
  start(): Promise<void>;
  isStarted(): boolean;
  dispose: () => Promise<void>;
  sendRequest(method: string, args: any): Promise<any>;
  sendNotification(method: string, args: any): Promise<void>;
  openFileContents(uri: string, contents: string): Promise<void>;
  registerProgress(token?: rpc.ProgressToken, callback?: (params: ProgressNotification) => Promise<void>): rpc.ProgressToken;
  getDiagnostics(): Promise<protocol.Diagnostic[]>;
}

export class LspClientImpl implements LspClient {
  private pendingProgress: Map<rpc.ProgressToken, Promise<void>>;
  protected childProcess: ChildProcess | undefined;

  protected connection: rpc.MessageConnection | undefined;

  public capabilities: protocol.ServerCapabilities | undefined;
  private readonly files: {
    [_: string]: {
      content: string;
      version: number;
      reportDiagnostics: ((_: protocol.Diagnostic[]) => void),
      resolvedDiagnostics: Promise<protocol.Diagnostic[]>,
    };
  };
  private fileWatcher: FileWatcher;
  private started: Promise<void> | undefined = undefined
  public constructor(
    public readonly id: string,
    public readonly languages: string[],
    public readonly extensions: string[],
    public readonly workspace: string,
    public readonly eagerStartup: boolean,
    private readonly waitForConfiguration: boolean,
    private readonly strictDiagnostics: boolean,
    private readonly command: string,
    private readonly args: string[],
    private readonly settings: object,
    private readonly logger: Logger, // TODO: better long term solution for logging
  ) {
    this.capabilities = undefined;
    this.files = {};
    this.pendingProgress = new Map();
    this.fileWatcher = new FileWatcher(extensions, this.workspace, this.logger, (uri, contents) => this.openFileContents(uri, contents), (uri) => this.sendDidClose(uri), (uri, contents) => this.openFileContents(uri, contents));
  }
  async spawnChildProcess(): Promise<{
    connection: rpc.MessageConnection;
    childProcess: ChildProcess;
  }> {
    const childProcess = (this.childProcess = spawn(this.command, this.args));

    if (!childProcess.stdout || !childProcess.stdin) {
      throw new Error("Child process not started");
    }
    childProcess.stderr.on("data", (data) => {
      this.logger.log(`lsp stderr: ${data}`);
    });

    const connection = (this.connection = rpc.createMessageConnection(
      new StreamMessageReader(childProcess.stdout),
      new StreamMessageWriter(childProcess.stdin),
      this.logger,
    ));
    this.logger.log(`LSP: Spawning child process ${this.command} ${this.args}`);
    return { connection, childProcess };
  }
  public async start() {
    let { promise: started, resolve: startedResolve, reject: _ } = Promise.withResolvers<void>()
    this.started = started
    // TODO: This should return a promise if the LSP is still starting
    // Just don't call start() twice and it'll be fine :)
    if (this.isStarted()) {
      return;
    }
    const { connection, childProcess } = await this.spawnChildProcess();
    this.connection = connection;
    connection.onError((error) => {
      this.logger.error(`Connection error: ${error}`);
      childProcess.kill();
    });

    connection.onClose(() => {
      this.logger.log("Connection closed");
      childProcess.kill();
    });
    const configured = new Promise<void>((resolve) => {
      connection.onRequest(
        protocol.ConfigurationRequest.type,
        ({ items }: protocol.ConfigurationParams) => {
          this.logger.log(
            `LSP: Configuration request for ${items.length} items ${JSON.stringify(items)}`,
          );
          const response = items.map((element) => {
            return this.settings;
          });
          resolve()
          return response;
        },
      );
    })
    connection.onNotification(
      protocol.LogMessageNotification.type,
      ({ message }) => {
        this.logger.log(`LSP: ${message}`);
      },
    );
    connection.onNotification(
      protocol.LogTraceNotification.type,
      ({ message }) => {
        this.logger.log(`LSP: ${message}`);
      },
    );
    connection.onNotification(
      protocol.PublishDiagnosticsNotification.type,
      (notification) => { this.handleDiagnostics(notification) },
    );
    connection.onRequest(
      protocol.ShowDocumentRequest.type,
      (
        request: protocol.ShowDocumentParams,
      ) => {
        this.logger.info(`Asked to show: ${JSON.stringify(request)}`);
        return null;
      },
    );
    connection.onRequest(
      protocol.ShowMessageRequest.type,
      (
        request: protocol.ShowMessageRequestParams,
        ___: rpc.CancellationToken,
      ): protocol.MessageActionItem | null => {
        this.logger.warn(`Unhandled request: ${JSON.stringify(request)}`);
        return null;
      },
    );
    connection.onUnhandledNotification((notification) => {
      this.logger.log(`Unhandled notification: ${JSON.stringify(notification)}`);
    });
    connection.onRequest(protocol.WorkDoneProgressCreateRequest.type, ({ token }) => {
      this.registerProgress(token)
    })

    connection.listen();
    const uri = `file://${this.workspace}`;
    const workspaceFolders = [{ "uri": uri, "name": "project" }]
    connection.onRequest(
      protocol.WorkspaceFoldersRequest.type,
      (): protocol.WorkspaceFolder[] => {

        return workspaceFolders;
      },
    );

    // TODO: We should figure out how to specify the capabilities we want
    const capabilities: protocol.ClientCapabilities = {
      workspace: {
        configuration: true,
        workspaceFolders: true,
      },
      general: {
        markdown: {
          parser: "Python-Markdown",
          version: "3.2.2"
        }
      },
      textDocument: {
        synchronization: {
          dynamicRegistration: true,
          didSave: true,
        },
        publishDiagnostics: {
          tagSupport: {
            valueSet: Object.values(protocol.DiagnosticTag),
          },
          versionSupport: true
        },
        completion: {
          completionItem: {
            documentationFormat: [protocol.MarkupKind.Markdown, protocol.MarkupKind.PlainText],
          }
        },
        signatureHelp: {
          signatureInformation: {
            documentationFormat: [protocol.MarkupKind.Markdown, protocol.MarkupKind.PlainText],
          }
        },
        hover: {
          contentFormat: [protocol.MarkupKind.Markdown, protocol.MarkupKind.PlainText],
        },
        documentSymbol: {
          symbolKind: { valueSet: Object.values(protocol.SymbolKind) },
          hierarchicalDocumentSymbolSupport: true,
        }
      },
      window: {
        workDoneProgress: true,
        showDocument: {
          support: true
        }
      }
    };
    const token = this.registerProgress();

    this.logger.log(`LSP workspace: ${uri}`);
    const response = await connection.sendRequest(InitializeRequest.type, {
      processId: process.pid,
      rootPath: this.workspace, // Used for eslint
      rootUri: uri, // Used by most lsps
      capabilities: capabilities,
      initializationOptions: this.settings,
      workDoneToken: token,
      workspaceFolders: workspaceFolders, // Technically correct approach
      trace: "verbose"
    });

    this.capabilities = response.capabilities;
    await connection.sendNotification(
      protocol.InitializedNotification.type,
      {},
    );
    if (this.waitForConfiguration) {
      await configured;
    }
    await this.fileWatcher.start()
    startedResolve()
  }

  public isStarted(): this is LspClientImpl & { connection: rpc.MessageConnection } {
    return !!this.connection;
  }

  private assertStarted(): asserts this is LspClientImpl & { connection: rpc.MessageConnection } {
    if (!this.connection) {
      throw new Error("Not started");
    }
  }

  async sendRequest(method: string, args: any): Promise<any> {
    await this.started

    this.assertStarted();

    return await this.connection.sendRequest(method, args);
  }

  registerProgress(token: rpc.ProgressToken = uuid(), callback?: (params: ProgressNotification) => Promise<void>): rpc.ProgressToken {
    const pending = new Promise<void>((resolve) => {
      if (this.connection) {
        this.connection.onProgress(
          protocol.WorkDoneProgress.type,
          token,
          async (message) => {
            this.logger.log(`LSP Progress: ${JSON.stringify(message)}`);
            if (callback) {
              let params = convertLspToMcp(message, token)
              await callback(params);
            }
            switch (message.kind) {
              case "begin":
                this.pendingProgress.set(token, pending);
                break
              case "end":
                resolve()
                this.pendingProgress.delete(token);
                break

            }
          },
        );
      }
    }
    )

    return token
  }
  async sendNotification(method: string, args: any): Promise<void> {
    if (!this.isStarted()) {
      await this.start();
    }

    this.assertStarted();

    return await this.connection.sendNotification(method, args);
  }
  async sendDidClose(uri: string) {
    if (this.files && uri in this.files) {
      await this.sendNotification(
        protocol.DidCloseTextDocumentNotification.method,
        {
          textDocument: {
            uri: uri,
          },
        },
      );
      delete this.files[uri]
    }
  }
  async sendDidOpen(uri: string, contents: string) {
    await this.sendNotification(
      protocol.DidOpenTextDocumentNotification.method,
      {
        textDocument: {
          uri: uri,
          languageId: "typescript",
          version: 1,
          text: contents,
        },
      },
    );

  }
  async sendDidChange(uri: string, contents: string, version: number) {
    await this.sendNotification(
      protocol.DidChangeTextDocumentNotification.method,
      {
        textDocument: {
          uri: uri,
          version: version,
        },
        contentChanges: [
          {
            text: contents,
          },
        ],
      },
    );

  }
  async sendDidSave(uri: string, contents: string) {
    if (typeof this.capabilities?.textDocumentSync === "object" && this.capabilities?.textDocumentSync?.save) {
      await this.sendNotification(
        protocol.DidSaveTextDocumentNotification.method,
        {
          textDocument: {
            uri: uri,
          },
          text: contents,
        },
      );
    }

  }
  // Lets the LSP know about a file contents
  public async openFileContents(uri: string, contents: string): Promise<void> {
    await this.started
    const { promise: resolvedDiagnostics, resolve: reportDiagnostics, reject: _ } = Promise.withResolvers<protocol.Diagnostic[]>()
    if (this.files && uri in this.files) {
      if (this.files[uri].content !== contents) {
        if (this.strictDiagnostics) {
          await this.files[uri].resolvedDiagnostics
        }
        this.logger.info(`LSP: File contents changed at ${uri}`);
        const version = this.files[uri].version + 1;
        this.files[uri] = { content: contents, version, resolvedDiagnostics, reportDiagnostics };
        await this.sendDidChange(uri, contents, version)
        await this.sendDidSave(uri, contents)
      }
    } else {
      this.files[uri] = { content: contents, version: 1, resolvedDiagnostics, reportDiagnostics };
      await this.sendDidOpen(uri, contents)
    }
  }
  async checkFiles() {
    await Promise.all(Object.keys(this.files).map(async (uri) => {
      const path = uri.split("file://")[1];
      const contents = await readFile(path, "utf-8");
      await this.openFileContents(uri, contents)
    }))
  }
  async waitForProgress() {
    await Promise.all(this.pendingProgress.values())
  }
  public async getDiagnostics() {
    await this.checkFiles();
    // Wait for any workDoneProgress requests to complete.
    // This indicates reindexing - so even if we're reindexing the entire project we will wait for it
    await this.waitForProgress()
    return (await Promise.all(Object.keys(this.files).map((uri) =>
      this.files[uri].resolvedDiagnostics
    ))).flat()
  }
  handleDiagnostics(notification: protocol.PublishDiagnosticsParams): void {
    if (notification.uri in this.files) {
      if (notification.version && notification.version !== this.files[notification.uri].version) {
        this.logger.warn("Rejecting outdated diagnostics for " + notification.uri)
        return
      }
      this.files[notification.uri].reportDiagnostics(notification.diagnostics)
    } else {
      this.logger.info("LSP: Recieved diagnostics for file wasn't opened " + notification.uri)
      for (const file in this.files) {
        // There is a condition where we may open files A and B, but the LSP may report diagnostics for B and C.
        // To handle this, if we get an unknown file, we will wait for diagnostics to be reported on it. But if they aren't within 3000ms, we can use the file C diagnostics as a default.
        const old = this.files[file].resolvedDiagnostics
        this.files[file].resolvedDiagnostics = Promise.race([old, setTimeout(3000).then(() => {
          this.files[file].reportDiagnostics(notification.diagnostics)
          return notification.diagnostics
        })])
      }
    }
    if (notification.diagnostics.length > 0) {
      this.logger.log(`LSP: Recieved Diagnostics ${JSON.stringify(notification, null, 2)}`);
    }
  }
  async dispose() {
    try {
      await this.fileWatcher.dispose()
      await this.connection?.sendRequest(protocol.ShutdownRequest.type)
      this.logger.log(`LSP: Killing ${this.command} ${this.args}`);
      this.connection?.dispose();
      this.childProcess?.kill();
    } catch (e: any) {
      this.logger.error(e.toString?.());
    }
  }
}
