import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AcpClient, extractUpdateText, type AcpServerRequest } from "./acp-client.js";
import { defaultCliPath } from "./doctor.js";
import { logEvent } from "./logger.js";
import { TaskRegistry } from "./task-registry.js";
import { newTaskId, now } from "./utils.js";
import type { ModelInfo, PermissionMode, PermissionRequestRecord, SessionMessageInput, SessionResult, SessionStartInput, TaskRecord } from "./types.js";
import { isRecord } from "./utils.js";

const execFileAsync = promisify(execFile);
// Deliberately local validation defaults. A future published package should
// require the caller to choose a model instead of assuming this order.
const LOCAL_TEST_MODEL_PRIORITY = ["hy4-preview", "deepseek-v4.1-flash"];

export class BridgeService {
  private readonly clients = new Map<string, AcpClient>();
  private readonly permissionWaiters = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly taskQueues = new Map<string, Promise<void>>();
  private readonly reports = new Map<string, { text: string; updates: unknown[] }>();
  private modelCatalog: ModelInfo[] = [];

  constructor(
    private readonly registry: TaskRegistry,
    private readonly cliPath = defaultCliPath()
  ) {}

  async start(input: SessionStartInput): Promise<SessionResult> {
    const cwd = resolve(input.cwd);
    const backend = input.backend === "cli" ? "cli" : "acp";
    const permissionMode = input.permissionMode ?? "plan";
    const task: TaskRecord = {
      taskId: newTaskId(),
      backend,
      cwd,
      modelId: input.modelId,
      permissionMode,
      status: "created",
      acceptanceCriteria: input.acceptanceCriteria,
      createdAt: now(),
      updatedAt: now(),
      submitted: false
    };
    await this.registry.put(task);
    logEvent("task_created", { taskId: task.taskId, backend, permissionMode });
    if (backend === "cli") return this.runCliFallback(task, input.prompt);
    let client: AcpClient | undefined;
    try {
      const models = input.modelId ? [input.modelId] : LOCAL_TEST_MODEL_PRIORITY;
      let lastError: unknown;
      let selectedModel: string | undefined;
      for (const candidate of models) {
        try {
          client = await AcpClient.start({
            cliPath: this.cliPath,
            cwd,
            permissionMode,
            modelId: candidate,
            onServerRequest: (request) => this.handleServerRequest(task.taskId, request),
            onExit: (error) => this.handleClientExit(task.taskId, error)
          });
          const session = await client.newSession();
          selectedModel = candidate;
          if (session.models) this.modelCatalog = normalizeModels(session.models, now());
          task.modelId = selectedModel;
          task.sessionId = session.sessionId;
          break;
        } catch (error) {
          lastError = error;
          if (client) await client.close();
          client = undefined;
        }
      }
      if (!client || !task.sessionId) throw lastError instanceof Error ? lastError : new Error("No configured WorkBuddy model is available");
      task.status = "running";
      await this.registry.put(task);
      this.clients.set(task.taskId, client);
      logEvent("task_session_started", { taskId: task.taskId, modelId: selectedModel, permissionMode });
      if (input.waitForCompletion) {
        const result = await this.runPrompt(task, client, input.prompt);
        this.reports.set(task.taskId, { text: result.text, updates: result.updates });
        return { ...result, task: (await this.registry.get(task.taskId))! };
      }
      void this.runPrompt(task, client, input.prompt)
        .then((result) => this.reports.set(task.taskId, { text: result.text, updates: result.updates }))
        .catch((error) => this.handleBackgroundPromptFailure(task.taskId, error));
      return { task: (await this.registry.get(task.taskId))!, text: "", updates: [] };
    } catch (error) {
      if (client) await client.close();
      const message = error instanceof Error ? error.message : String(error);
      const current = await this.registry.get(task.taskId);
      if (current?.submitted) {
        await this.registry.update(task.taskId, { status: "uncertain", lastError: message });
        throw error;
      }
      if (input.backend !== "acp") return this.runCliFallback(task, input.prompt, message);
      await this.registry.update(task.taskId, { status: "failed", lastError: message });
      throw error;
    }
  }

  async send(input: SessionMessageInput): Promise<SessionResult> {
    const run = async (): Promise<SessionResult> => {
      const task = await this.requireTask(input.taskId);
      if (task.backend === "cli") throw new Error("CLI fallback tasks are one-shot and do not support session_send");
      if (!task.sessionId) throw new Error(`Task ${task.taskId} has no ACP session`);
      if (task.status === "uncertain") throw new Error("Task is uncertain; refusing to replay a prompt");
      let client = this.clients.get(task.taskId);
      if (!client) {
        client = await AcpClient.start({
          cliPath: this.cliPath,
          cwd: task.cwd,
          permissionMode: task.permissionMode,
          modelId: task.modelId,
          onServerRequest: (request) => this.handleServerRequest(task.taskId, request),
          onExit: (error) => this.handleClientExit(task.taskId, error)
        });
        try {
          await client.loadSession(task.sessionId);
        } catch (error) {
          await client.close();
          await this.registry.update(task.taskId, { status: "uncertain", lastError: error instanceof Error ? error.message : String(error) });
          throw new Error(`Unable to load persisted ACP session; task marked uncertain`);
        }
        this.clients.set(task.taskId, client);
      }
      const result = await this.sendInternal(task, client, input.message);
      this.reports.set(task.taskId, { text: result.text, updates: result.updates });
      return result;
    };
    return this.withTaskLock(input.taskId, run);
  }

  async status(taskId: string): Promise<TaskRecord> {
    return this.requireTask(taskId);
  }

  hasReport(taskId: string): boolean {
    return this.reports.has(taskId);
  }

  async report(taskId: string): Promise<SessionResult> {
    const task = await this.requireTask(taskId);
    const report = this.reports.get(taskId);
    if (!report) throw new Error(`No in-memory report is available for task ${taskId}`);
    return { task, text: report.text, updates: report.updates };
  }

  async listTasks(): Promise<TaskRecord[]> {
    return this.registry.list();
  }

  async cancel(taskId: string): Promise<TaskRecord> {
    const task = await this.requireTask(taskId);
    if (task.sessionId && this.clients.has(taskId)) {
      const client = this.clients.get(taskId)!;
      try {
        await client.cancel(task.sessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/method not found|session\/cancel/i.test(message)) throw error;
        // WorkBuddy 2.137.1 exposes ACP prompt/session but rejects the
        // standard session/cancel method. Killing this task-local process is
        // the safe compatibility fallback; the persisted session can still
        // be loaded by the next session_send.
        this.rejectPermissionWaiters(taskId, new Error("ACP client cancelled"));
        await client.close();
        this.clients.delete(taskId);
        logEvent("task_cancel_fallback", { taskId });
      }
    }
    logEvent("task_cancelled", { taskId });
    return this.registry.update(taskId, { status: "cancelled" });
  }

  async close(taskId: string): Promise<TaskRecord> {
    const client = this.clients.get(taskId);
    if (client) {
      this.rejectPermissionWaiters(taskId, new Error("ACP client closed"));
      await client.close();
      this.clients.delete(taskId);
    }
    logEvent("task_closed", { taskId });
    return this.registry.update(taskId, { status: "completed" });
  }

  async replyPermission(taskId: string, requestId: string, response: unknown): Promise<TaskRecord> {
    const task = await this.requireTask(taskId);
    const key = permissionKey(taskId, requestId);
    const waiter = this.permissionWaiters.get(key);
    if (!waiter) throw new Error(`Permission request ${requestId} is not active in this Bridge process`);
    const pending = (task.pendingPermissions ?? []).filter((request) => request.requestId !== requestId);
    await this.registry.update(taskId, { pendingPermissions: pending.length ? pending : undefined });
    this.permissionWaiters.delete(key);
    waiter.resolve(response);
    logEvent("permission_replied", { taskId, requestId });
    return (await this.registry.get(taskId))!;
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.modelCatalog.length) return [...this.modelCatalog];
    let lastError: unknown;
    for (const modelId of LOCAL_TEST_MODEL_PRIORITY) {
      let client: AcpClient | undefined;
      try {
        client = await AcpClient.start({ cliPath: this.cliPath, cwd: process.cwd(), permissionMode: "plan", modelId, noSessionPersistence: true });
        const session = await client.newSession();
        this.modelCatalog = normalizeModels(session.models, now());
        return [...this.modelCatalog];
      } catch (error) {
        lastError = error;
      } finally {
        await client?.close();
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Unable to load WorkBuddy models");
  }

  private async sendInternal(task: TaskRecord, client: AcpClient, message: string): Promise<SessionResult> {
    logEvent("task_prompt_submitted", { taskId: task.taskId, backend: task.backend });
    await this.registry.update(task.taskId, { status: "running", submitted: true });
    const response = await client.prompt(task.sessionId!, message);
    const text = response.text || extractUpdateText(response.updates);
    const current = await this.registry.get(task.taskId);
    if (current?.status !== "cancelled" && current?.status !== "completed") {
      await this.registry.update(task.taskId, { status: "awaiting_review" });
      logEvent("task_prompt_completed", { taskId: task.taskId, status: "awaiting_review" });
    }
    return { task: (await this.registry.get(task.taskId))!, text, updates: response.updates };
  }

  private async handleServerRequest(taskId: string, request: AcpServerRequest): Promise<unknown> {
    if (!request.method.toLowerCase().includes("permission")) {
      throw new Error(`Unsupported ACP server request: ${request.method}`);
    }
    const requestId = String(request.id);
    const record: PermissionRequestRecord = { requestId, method: request.method, params: request.params, createdAt: now() };
    const task = await this.requireTask(taskId);
    await this.registry.update(taskId, { pendingPermissions: [...(task.pendingPermissions ?? []), record] });
    logEvent("permission_requested", { taskId, requestId, method: request.method });
    return new Promise((resolve, reject) => {
      this.permissionWaiters.set(permissionKey(taskId, requestId), { resolve, reject });
    });
  }

  private handleClientExit(taskId: string, error: Error): void {
    this.rejectPermissionWaiters(taskId, error);
  }

  private rejectPermissionWaiters(taskId: string, error: Error): void {
    for (const [key, waiter] of this.permissionWaiters) {
      if (!key.startsWith(`${taskId}:`)) continue;
      this.permissionWaiters.delete(key);
      waiter.reject(error);
    }
  }

  private async withTaskLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.taskQueues.get(taskId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const queued = previous.then(() => current);
    this.taskQueues.set(taskId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.taskQueues.get(taskId) === queued) this.taskQueues.delete(taskId);
    }
  }

  private async requireTask(taskId: string): Promise<TaskRecord> {
    const task = await this.registry.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }

  private async runCliFallback(task: TaskRecord, prompt: string, preflightError?: string): Promise<SessionResult> {
    const modelId = task.modelId ?? "hy4-preview";
    task.backend = "cli";
    task.modelId = modelId;
    await this.registry.put(task);
    await this.registry.update(task.taskId, { status: "running", submitted: true, lastError: preflightError });
    try {
      const commandResult = await execFileAsync(process.execPath, [this.cliPath, "-p", "--output-format", "json", "--no-session-persistence", "--permission-mode", task.permissionMode, "--model", modelId, prompt], { cwd: task.cwd, timeout: 30 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 });
      let text = commandResult.stdout.trim();
      try {
        const parsed = JSON.parse(text) as unknown;
        if (Array.isArray(parsed)) {
          const resultEvent = [...parsed].reverse().find((item) => isRecord(item) && item.type === "result" && typeof item.result === "string");
          const messageEvent = [...parsed].reverse().find((item) => isRecord(item) && typeof item.text === "string");
          if (isRecord(resultEvent) && typeof resultEvent.result === "string") text = resultEvent.result;
          else if (isRecord(messageEvent) && typeof messageEvent.text === "string") text = messageEvent.text;
        } else if (isRecord(parsed)) {
          if (typeof parsed.result === "string") text = parsed.result;
          else if (typeof parsed.text === "string") text = parsed.text;
        }
      } catch {
        // Keep plain text output.
      }
      await this.registry.update(task.taskId, { status: "awaiting_review" });
      logEvent("cli_fallback_completed", { taskId: task.taskId, modelId });
      const result = { task: (await this.registry.get(task.taskId))!, text, updates: [] };
      this.reports.set(task.taskId, { text, updates: [] });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.registry.update(task.taskId, { status: "uncertain", lastError: message });
      throw error;
    }
  }

  private async runPrompt(task: TaskRecord, client: AcpClient, message: string): Promise<SessionResult> {
    return this.withTaskLock(task.taskId, () => this.sendInternal(task, client, message));
  }

  private async handleBackgroundPromptFailure(taskId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const current = await this.registry.get(taskId);
    if (!current) return;
    if (current.status === "cancelled" || current.status === "completed") return;
    await this.registry.update(taskId, { status: current.submitted ? "uncertain" : "failed", lastError: message });
    logEvent("task_prompt_failed", { taskId, status: current.submitted ? "uncertain" : "failed" });
  }
}

function normalizeModels(value: unknown, fetchedAt: string): ModelInfo[] {
  if (!isRecord(value) || !Array.isArray(value.availableModels)) return [];
  return value.availableModels.flatMap((item): ModelInfo[] => {
    if (!isRecord(item) || typeof item.modelId !== "string" || typeof item.name !== "string") return [];
    const meta = isRecord(item._meta) ? item._meta : {};
    return [{
      modelId: item.modelId,
      name: item.name,
      description: typeof item.description === "string" ? item.description : null,
      credits: typeof meta.credits === "string" ? meta.credits : undefined,
      maxInputTokens: typeof meta.maxInputTokens === "number" ? meta.maxInputTokens : undefined,
      supportsImages: typeof meta.supportsImages === "boolean" ? meta.supportsImages : undefined,
      supportsReasoning: typeof meta.supportsReasoning === "boolean" ? meta.supportsReasoning : undefined,
      source: "codebuddy-acp session/new",
      fetchedAt
    }];
  });
}

function permissionKey(taskId: string, requestId: string): string {
  return `${taskId}:${requestId}`;
}
