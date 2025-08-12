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
import { Mutex } from "async-mutex";
import { fileUriToPath, pathToFileUri } from "./lsp-methods";
import { resolve } from "path";

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
  getDiagnostics(file?: string): Promise<protocol.Diagnostic[]>;
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
      previousDiagnosticId?: string
      diagnosticId?: string
    };
  };
  private previousDiagnostics: Map<string, protocol.Diagnostic[]>
  private fileWatcher: FileWatcher;
  private started: Promise<void> | undefined = undefined
  private readonly locks: Map<string, Mutex>
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
    this.locks = new Map()
    this.previousDiagnostics = new Map();
    this.fileWatcher = new FileWatcher(extensions, this.workspace, this.logger, (uri) => this.openFileContents(uri), (uri) => this.sendDidClose(uri), (uri) => this.openFileContents(uri));
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
        publishDiagnostics: {
          tagSupport: {
            valueSet: Object.values(protocol.DiagnosticTag),
          },
          versionSupport: true,
          relatedInformation: true,
          dataSupport: true,
          codeDescriptionSupport: true,
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
  private async ensureStarted() {
    if (this.started === undefined) {
      await this.start();
    }
    await this.started
  }
  async sendRequest(method: string, args: any): Promise<any> {
    await this.ensureStarted()

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
    const { promise: resolvedDiagnostics, resolve: reportDiagnostics, reject: _ } = Promise.withResolvers<protocol.Diagnostic[]>()
    this.files[uri] = { content: contents, version, resolvedDiagnostics, reportDiagnostics, previousDiagnosticId, diagnosticId: undefined };
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
    const initialContents = contents ?? await readFile(fileUriToPath(uri), "utf-8")
    const lock = this.locks.get(uri)
    if (this.files && uri in this.files && lock !== undefined) {
      // Case 2: We can lock the file to ensure only one update happens at a time.
      await lock.acquire()
      try {
        // If many updates are happening quickly to the same file, we want to read the latest version of the file. Say 3 updates happen in quick succession:
        // 1 to contents A
        // 2 to contents B
        // 3 to contents C
        //
        // We execute the first request and are now waiting on the language server. Since we call await, the other 2 requests, will read their files.
        //
        // 1 to contents A  (pending)
        // 2 to contents B (blocked)
        // 3 to contents C (blocked)
        //
        // When it finishes, we may execute 2 or 3 without knowing which one. By re-reading the file here, we ensure that one is run with the latest contents and the other is skipped.
        //
        //
        // Since this lock is per-file, this shouldn't impact the performance of edits across multiple files.
        // High-stress cases are:
        // a. Repeated edits to 1 file.
        // b. Edits to multiple files.
        //
        // In case a:
        // If we have N edits, the first edit will open the document and get diagnostics.
        // Since we aren't I/O bound with the filesystem, by the time we have a response, the filesystem will have the contents of the Nth request on disk.
        // This means that the second request (regardless of which one it is) will wait for the diagnostics of the first file and then read the file belonging to the last edit.
        // Then the 3rd request would wait for the diagnostics of the second request and then no-op since the file hasn't changed.
        // All subsequent requests will return instantly since they don't need to wait for the diagnostics.
        // Even if the second request doesn't match the Nth request, the 3rd request will.
        // Basically we have a bounded amount of delay that can be introduced here since eventually the agent will request diagnostics and it will need to wait for the file to be updated.
        //
        // In case b:
        // We don't lock the entire map, just each file
        // This means all the requests will occur in parallel (though in practice, we'll get diagnostics for all of them around the same time).
        // Individually, they'll follow the same characteristics of case a.
        // They can still block the event loop so the priority should be to maximize async I/O and minimize blocking.
        // This is currently a problem when doing a git pull.
        if (this.strictDiagnostics) {
          await this.files[uri].resolvedDiagnostics
        }
        contents = contents ?? await readFile(fileUriToPath(uri), "utf-8")
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
  async waitForProgress() {
    await Promise.all(this.pendingProgress.values())
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
        if(!previousResultId) {
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

  public async getDiagnostics(file?: string) {
    await this.ensureStarted()
    this.assertStarted()
    if (file !== undefined) {
      file = resolve(file)
    }
    // If we're given a specific file, the agent may have called it without modifying it or opening it. This means we need to open it manually.
    if (file !== undefined) {
      const uri = pathToFileUri(file)
      await this.openFileContents(uri)
      if (this.capabilities?.diagnosticProvider !== undefined) {
        return await this.getPullDiagnostics(uri)
      }
    }
    // Read all the files that have been opened and send change requests as appropriate.
    await this.checkFiles();
    // Wait for any workDoneProgress requests to complete.
    // This indicates reindexing - so even if we're reindexing the entire project we will wait for it
    await this.waitForProgress()
    if (file !== undefined) {
      return await this.files[pathToFileUri(file)].resolvedDiagnostics
    }
    return (await Promise.all(Object.keys(this.files).map((uri) =>
      this.capabilities?.diagnosticProvider !== undefined ? this.getPullDiagnostics(uri) : this.files[uri].resolvedDiagnostics
    ))).flat()
  }
  queueAllDiagnostics(diagnostics: protocol.Diagnostic[], delay: number): void {

    for (const file in this.files) {
      const old = this.files[file].resolvedDiagnostics
      this.files[file].resolvedDiagnostics = Promise.race([old, setTimeout(delay).then(() => {
        this.logger.warn(`LSP: Diagnostics timed out for ${file}`)
        this.files[file].reportDiagnostics(diagnostics)
        return diagnostics
      })])
    }
  }
  handleDiagnostics(notification: protocol.PublishDiagnosticsParams): void {
    if (notification.uri in this.files) {
      this.logger.log(`LSP: Recieved Diagnostics for file ${notification.uri}`);
      if (notification.version && notification.version !== this.files[notification.uri].version) {
        this.logger.warn("Rejecting outdated diagnostics for " + notification.uri)
        return
      }
      this.files[notification.uri].reportDiagnostics(notification.diagnostics)
      this.queueAllDiagnostics([], 10000) // Wait  10 seconds. Sometimes vtsls will only send diagnostics for files with errors when diagnostics are requested for multiple files
    } else {
      this.logger.info("LSP: Recieved diagnostics for file wasn't opened " + notification.uri)
      // There is a condition where we may open files A and B, but the LSP may report diagnostics for B and C.
      // To handle this, if we get an unknown file, we will wait for diagnostics to be reported on it. But if they aren't within 3000ms, we can use the file C diagnostics as a default.
      this.queueAllDiagnostics(notification.diagnostics, 3000)
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
