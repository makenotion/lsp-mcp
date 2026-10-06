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
import { Mutex } from "async-mutex";
import { fileUriToPath, pathToFileUri } from "./lsp-methods";
import path, { resolve } from "path";
import { buildClientInfo } from "./version";

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
  openFileContents(uri: string, contents?: string): Promise<void>;
  registerProgress(token?: rpc.ProgressToken, callback?: (params: ProgressNotification) => Promise<void>): rpc.ProgressToken;
  getDiagnostics(file: string): Promise<protocol.Diagnostic[]>;
}

export class LspClientImpl implements LspClient {
  protected childProcess: ChildProcess | undefined;

  protected connection: rpc.MessageConnection | undefined;

  public capabilities: protocol.ServerCapabilities | undefined;
  private readonly files: {
    [_: string]: {
      content: string;
      version: number;
      previousDiagnosticId?: string
      diagnosticId?: string
    };
  };
  private previousDiagnostics: Map<string, protocol.Diagnostic[]>
  private started: Promise<void> | undefined = undefined
  private readonly locks: Map<string, Mutex>
  public constructor(
    public readonly id: string,
    public readonly languages: string[],
    public readonly extensions: string[],
    public readonly workspace: string,
    public readonly eagerStartup: boolean,
    private readonly waitForConfiguration: boolean,
    private readonly command: string,
    private readonly args: string[],
    private readonly settings: object,
    private readonly logger: Logger, // TODO: better long term solution for logging
    // Resolved lazily since the agent isn't known until the MCP handshake completes
    private readonly getClientInfo: () => { name: string; version: string } = () => buildClientInfo(),
  ) {
    this.capabilities = undefined;
    this.files = {};
    this.locks = new Map()
    this.previousDiagnostics = new Map();
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
    connection.onRequest(
      protocol.RegistrationRequest.type,
      (
        request: protocol.RegistrationParams,
        ___: rpc.CancellationToken,
      ) => {
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
        },
        diagnostic: {
          relatedDocumentSupport: false
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
      clientInfo: this.getClientInfo(),
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
  private async ensureStarted() {
    if (this.started === undefined) {
      await this.start();
    }
    await this.started
  }
  async sendRequest(method: string, args: any): Promise<any> {
    await this.ensureStarted()

    this.assertStarted();
    // Open files take precedence over disk in the LSP, so sync any that changed since they were opened.
    await this.checkFiles();

    return await this.connection.sendRequest(method, args);
  }

  registerProgress(token: rpc.ProgressToken = uuid(), callback?: (params: ProgressNotification) => Promise<void>): rpc.ProgressToken {
    this.connection?.onProgress(
      protocol.WorkDoneProgress.type,
      token,
      async (message) => {
        this.logger.log(`LSP Progress: ${JSON.stringify(message)}`);
        if (callback) {
          let params = convertLspToMcp(message, token)
          await callback(params);
        }
      },
    );

    return token
  }
  async sendNotification(method: string, args: any): Promise<void> {
    await this.ensureStarted()

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
          languageId: "typescriptreact",
          version: 1,
          text: contents,
        },
      },
    );

  }
  async sendDidChange(uri: string, contents: string, oldContents: string, version: number) {
    const split = oldContents.split("\n")
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
            range: {
              start: { line: 0, character: 0 },
              end: { line: split.length - 1, character: split[split.length - 1].length }
            }
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
  updateFileEntry(uri: string, version: number, contents: string, previousDiagnosticId?: string): string {
    this.files[uri] = { content: contents, version, previousDiagnosticId, diagnosticId: undefined };
    return contents

  }
  // Lets the LSP know about a file contents.
  // @param contents - The contents of the file. If not specified, read from disk. Only set this parameter this if the file isn't written to the disk.
  public async openFileContents(uri: string, contents?: string): Promise<void> {
    await this.started
    // We have 2 kinds of potential issues:
    // 1. 2 opens of the same file
    // 2. 2 updates of the same file
    //
    // Case 1:
    // To avoid using a mutex here, we must check if the file is in our list of files then immediately add it to the list of files if it isn't.
    // This means we must read the file before we know if it's in the list of files
    let initialContents = contents
    if (initialContents === undefined) {
      try {
        initialContents = await readFile(fileUriToPath(uri), "utf-8")
      } catch {
        return await this.sendDidClose(uri)
      }
    }
    const lock = this.locks.get(uri)
    if (this.files && uri in this.files && lock !== undefined) {
      // Case 2: We can lock the file to ensure only one update happens at a time.
      await lock.acquire()
      try {
        // Re-read the file under the lock so that concurrent updates converge on the latest contents.
        if (contents === undefined) {
          try {
            contents = await readFile(fileUriToPath(uri), "utf-8")
          } catch {
            return await this.sendDidClose(uri)
          }
        }
        if (this.files[uri].content.trimEnd() !== contents.trimEnd()) {
          const oldContents = this.files[uri].content
          this.logger.info(`LSP: File contents changed at ${uri}`);
          const version = this.files[uri].version + 1;
          this.updateFileEntry(uri, version, contents, this.files[uri].diagnosticId)
          await this.sendDidChange(uri, contents, oldContents, version)
          await this.sendDidSave(uri, contents)
        }

      } finally {
        lock.release()
      }
    } else {
      this.logger.info(`Sending didOpen at ${uri}`)
      this.locks.set(uri, new Mutex())
      const newContents = this.updateFileEntry(uri, 1, initialContents)
      await this.sendDidOpen(uri, newContents)
    }
  }
  async checkFiles() {
    await Promise.all(Object.keys(this.files).map(async (uri) => {
      await this.openFileContents(uri)
    }))
  }
  async getPullDiagnostics(uri: string): Promise<protocol.Diagnostic[]> {
    await this.ensureStarted()
    this.assertStarted()
    const identifier = this.files[uri].diagnosticId ?? uuid()
    this.files[uri].diagnosticId = identifier
    const previousResultId = this.files[uri].previousDiagnosticId
    const result = await this.connection.sendRequest(protocol.DocumentDiagnosticRequest.type, {
      textDocument: {
        uri
      },
      identifier,
      previousResultId,
    })
    let items: protocol.Diagnostic[]
    switch (result?.kind) {
      case "full":
        items = result.items
        break
      case "unchanged":
        if (!previousResultId) {
          this.logger.warn(`LSP: No previous result id found for ${uri}`)
          items = []
          break
        }
        if (!this.previousDiagnostics.has(previousResultId)) {
          this.logger.warn(`LSP: No diagnostics found for ${uri} with identifier ${previousResultId}`)
        }
        items = this.previousDiagnostics.get(previousResultId) ?? []
        break
    }
    this.previousDiagnostics.set(identifier, items)
    return items
  }
  attachFileName(diagnostics: protocol.Diagnostic[], uri: string): protocol.Diagnostic[] {
    const file = fileUriToPath(uri).replace(path.resolve(this.workspace) + "/", "")
    return diagnostics.map((diagnostic) => {
      return {
        path: file,
        ...diagnostic
      }
    })
  }


  public async getDiagnostics(file: string) {
    await this.ensureStarted()
    this.assertStarted()
    file = resolve(file)
    // The agent may have called this without modifying the file or opening it. This means we need to open it manually.
    const uri = pathToFileUri(file)
    await this.openFileContents(uri)
    // Open files take precedence over disk in the LSP, so sync any that changed since they were opened.
    await this.checkFiles();
    if (this.capabilities?.diagnosticProvider === undefined) {
      throw new Error(`LSP ${this.id} doesn't support pull diagnostics`)
    }
    return this.attachFileName(await this.getPullDiagnostics(uri), file)
  }
  async dispose() {
    try {
      await this.connection?.sendRequest(protocol.ShutdownRequest.type)
      this.logger.log(`LSP: Killing ${this.command} ${this.args}`);
      this.connection?.dispose();
      this.childProcess?.kill();
    } catch (e: any) {
      this.logger.error(e.toString?.());
    }
  }
}
