import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { isRecord, textFromContent } from "./utils.js";

export interface AcpClientOptions {
  cliPath: string;
  cwd: string;
  permissionMode: string;
  modelId?: string;
  noSessionPersistence?: boolean;
  onServerRequest?: (request: AcpServerRequest) => Promise<unknown>;
  onExit?: (error: Error) => void;
}

export interface AcpServerRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

export interface AcpUpdate {
  sessionId?: string;
  update?: unknown;
  raw: unknown;
}

export class AcpClient {
  private readonly process: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly updates: AcpUpdate[] = [];
  private readonly lineReader;
  private closed = false;

  private constructor(private readonly options: AcpClientOptions, child: ChildProcessWithoutNullStreams) {
    this.process = child;
    this.lineReader = createInterface({ input: child.stdout });
    this.lineReader.on("line", (line) => this.onLine(line));
    child.on("error", (error) => {
      this.failPending(error);
      this.options.onExit?.(error);
    });
    child.on("exit", (code, signal) => {
      if (!this.closed) {
        const error = new Error(`ACP process exited (${code ?? "null"}/${signal ?? "none"})`);
        this.failPending(error);
        this.options.onExit?.(error);
      }
    });
  }

  static async start(options: AcpClientOptions): Promise<AcpClient> {
    const args = [options.cliPath, "--acp", "--permission-mode", options.permissionMode];
    if (options.modelId) args.push("--model", options.modelId);
    if (options.noSessionPersistence) args.push("--no-session-persistence");
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const client = new AcpClient(options, child);
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "workbuddy-subagent-bridge", version: "0.1.0" }
    });
    return client;
  }

  async newSession(): Promise<{ sessionId: string; models?: unknown }> {
    const result = await this.request("session/new", { cwd: this.options.cwd, mcpServers: [] });
    if (!isRecord(result) || typeof result.sessionId !== "string") throw new Error("ACP session/new returned no sessionId");
    return { sessionId: result.sessionId, models: result.models };
  }

  async loadSession(sessionId: string): Promise<void> {
    await this.request("session/load", { sessionId, cwd: this.options.cwd, mcpServers: [] });
  }

  async prompt(sessionId: string, message: string): Promise<{ text: string; updates: AcpUpdate[] }> {
    this.updates.length = 0;
    const result = await this.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: message }]
    });
    const text = isRecord(result) ? textFromContent(result.content) || textFromContent(result.message) : "";
    return { text, updates: [...this.updates] };
  }

  async cancel(sessionId: string): Promise<void> {
    await this.request("session/cancel", { sessionId });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lineReader.close();
    const exited = this.process.exitCode !== null || this.process.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => this.process.once("exit", () => resolve()));
    this.process.kill();
    this.failPending(new Error("ACP client closed"));
    // On Windows the child can keep its working directory locked briefly after
    // kill(). Await exit so callers can safely tear down temporary workspaces.
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 1000))]);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(value)) return;
    if (typeof value.method === "string" && (typeof value.id === "number" || typeof value.id === "string")) {
      void this.handleServerRequest({ id: value.id, method: value.method, params: value.params });
      return;
    }
    if (typeof value.id === "number" && this.pending.has(value.id)) {
      const pending = this.pending.get(value.id)!;
      this.pending.delete(value.id);
      if (isRecord(value.error)) pending.reject(new Error(String(value.error.message ?? "ACP request failed")));
      else pending.resolve(value.result);
      return;
    }
    if (value.method === "session/update" && isRecord(value.params)) {
      this.updates.push({ sessionId: typeof value.params.sessionId === "string" ? value.params.sessionId : undefined, update: value.params.update, raw: value });
    }
  }

  private async handleServerRequest(request: AcpServerRequest): Promise<void> {
    try {
      if (!this.options.onServerRequest) throw new Error(`Unsupported ACP server request: ${request.method}`);
      const result = await this.options.onServerRequest(request);
      this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    } catch (error) {
      this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: error instanceof Error ? error.message : String(error) } })}\n`);
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function extractUpdateText(updates: AcpUpdate[]): string {
  return updates
    .map((item) => {
      if (!isRecord(item.update)) return "";
      // WorkBuddy emits both private reasoning chunks and user-visible message
      // chunks through session/update. Only return the latter to the parent
      // agent; forwarding thoughts would leak internal reasoning into results.
      if (item.update.sessionUpdate !== "agent_message_chunk") return "";
      return textFromContent(item.update.content);
    })
    .filter(Boolean)
    .join("");
}

export function requestId(): string {
  return randomUUID();
}
