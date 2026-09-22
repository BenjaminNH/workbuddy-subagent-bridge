import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { resolve } from "node:path";
import { BridgeService } from "./service.js";
import { TaskRegistry } from "./task-registry.js";
import type { PermissionMode } from "./types.js";

const permissionModes: PermissionMode[] = ["plan", "default", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "fullAccess", "delegate"];
const permissionDescription = "WorkBuddy permission mode. Default plan: read/analyze only. acceptEdits: auto-accept file edits. bypassPermissions: skip permission prompts (danger). fullAccess: skip all permission checks including dangerous commands (extreme danger). Other values pass through to the current WorkBuddy version.";

export async function createMcpServer(statePath: string, cliPath?: string): Promise<Server> {
  const registry = new TaskRegistry(statePath);
  await registry.load();
  const service = new BridgeService(registry, cliPath);
  const server = new Server({ name: "workbuddy-subagent-bridge", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: "workbuddy_session_start", description: "Start a current-version WorkBuddy session. ACP mode returns a taskId immediately by default; poll status and request the report after completion. Set waitForCompletion=true when a blocking report is preferred.", inputSchema: { type: "object", required: ["cwd", "prompt"], properties: { cwd: { type: "string", description: "Explicit existing workspace directory." }, prompt: { type: "string" }, modelId: { type: "string", description: "Optional model ID. Local validation fallback tries hy4-preview then deepseek-v4.1-flash when omitted." }, backend: { type: "string", enum: ["auto", "acp", "cli"], default: "auto", description: "auto prefers ACP and may use one-shot CLI fallback only before a prompt is submitted." }, permissionMode: { type: "string", enum: permissionModes, default: "plan", description: permissionDescription }, acceptanceCriteria: { type: "string" }, waitForCompletion: { type: "boolean", default: false, description: "If true, wait for the first prompt report; otherwise return the taskId immediately." } } } },
    { name: "workbuddy_session_send", description: "Send a follow-up message to the same WorkBuddy session.", inputSchema: { type: "object", required: ["taskId", "message"], properties: { taskId: { type: "string" }, message: { type: "string" } } } },
    { name: "workbuddy_session_status", description: "Read task/session status and any pending ACP permission requests without sending a prompt.", inputSchema: { type: "object", required: ["taskId"], properties: { taskId: { type: "string" } } } },
    { name: "workbuddy_session_cancel", description: "Cancel the active WorkBuddy session.", inputSchema: { type: "object", required: ["taskId"], properties: { taskId: { type: "string" } } } },
    { name: "workbuddy_session_close", description: "Close the local ACP process and mark the task completed.", inputSchema: { type: "object", required: ["taskId"], properties: { taskId: { type: "string" } } } },
    { name: "workbuddy_session_permission_reply", description: "Reply to a pending ACP permission request. Inspect workbuddy_session_status first and pass the raw response payload expected by the current WorkBuddy version.", inputSchema: { type: "object", required: ["taskId", "requestId", "response"], properties: { taskId: { type: "string" }, requestId: { type: "string" }, response: { type: "object", description: "Raw ACP permission response payload; do not invent a format if the current WorkBuddy request provides an explicit choice schema." } } } },
    { name: "workbuddy_session_report", description: "Read the in-memory report produced by a completed prompt. Reports are not persisted in the task registry.", inputSchema: { type: "object", required: ["taskId"], properties: { taskId: { type: "string" } } } },
    { name: "workbuddy_status", description: "List persisted WorkBuddy tasks and their current lifecycle status.", inputSchema: { type: "object", properties: {} } },
    { name: "workbuddy_models", description: "List models returned by the current WorkBuddy ACP session/new response.", inputSchema: { type: "object", properties: {} } },
    { name: "workbuddy_doctor", description: "Check Node, CodeBuddy CLI, and ACP stdio initialization.", inputSchema: { type: "object", properties: {} } }
  ] }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      let result: unknown;
      switch (request.params.name) {
        case "workbuddy_session_start":
          result = await service.start({ cwd: String(args.cwd), prompt: String(args.prompt), modelId: optionalString(args.modelId), permissionMode: parsePermissionMode(args.permissionMode), backend: parseBackend(args.backend), acceptanceCriteria: optionalString(args.acceptanceCriteria), waitForCompletion: args.waitForCompletion === true });
          break;
        case "workbuddy_session_send": result = await service.send({ taskId: String(args.taskId), message: String(args.message) }); break;
        case "workbuddy_session_status": result = await service.status(String(args.taskId)); break;
        case "workbuddy_session_cancel": result = await service.cancel(String(args.taskId)); break;
        case "workbuddy_session_close": result = await service.close(String(args.taskId)); break;
        case "workbuddy_session_permission_reply":
          if (args.response === undefined) throw new Error("response is required for workbuddy_session_permission_reply");
          result = await service.replyPermission(String(args.taskId), String(args.requestId), args.response);
          break;
        case "workbuddy_session_report": result = await service.report(String(args.taskId)); break;
        case "workbuddy_status": result = await service.listTasks(); break;
        case "workbuddy_models": result = await service.listModels(); break;
        case "workbuddy_doctor": { const { runDoctor } = await import("./doctor.js"); result = await runDoctor(cliPath); break; }
        default: return { content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }], isError: true };
      }
      if (request.params.name === "workbuddy_session_start" && isTaskResult(result)) {
        const risk = permissionRisk(result.task.permissionMode);
        result = { ...result, permissionRisk: risk.level, permissionWarning: risk.warning };
      }
      if (request.params.name === "workbuddy_session_status" && result && typeof result === "object") {
        result = { task: result, reportAvailable: service.hasReport(String(args.taskId)) };
      }
      result = sanitizeSessionResult(result);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });
  return server;
}

export async function startMcpServer(statePath = defaultStatePath(), cliPath?: string): Promise<void> {
  const server = await createMcpServer(statePath, cliPath);
  await server.connect(new StdioServerTransport());
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

function parsePermissionMode(value: unknown): PermissionMode | undefined {
  const mode = optionalString(value);
  return mode && permissionModes.includes(mode as PermissionMode) ? mode as PermissionMode : undefined;
}

function parseBackend(value: unknown): "auto" | "acp" | "cli" | undefined {
  const backend = optionalString(value);
  return backend === "auto" || backend === "acp" || backend === "cli" ? backend : undefined;
}

function isTaskResult(value: unknown): value is { task: { permissionMode: PermissionMode } } {
  return typeof value === "object" && value !== null && "task" in value && typeof (value as { task?: { permissionMode?: unknown } }).task?.permissionMode === "string";
}

function permissionRisk(mode: PermissionMode): { level: "normal" | "elevated" | "danger" | "extreme"; warning: string } {
  if (mode === "fullAccess") return { level: "extreme", warning: "Danger: fullAccess skips all permission checks, including dangerous commands." };
  if (mode === "bypassPermissions") return { level: "danger", warning: "Danger: bypassPermissions skips permission prompts and may allow commands, dependency installation, and network access." };
  if (mode === "acceptEdits") return { level: "elevated", warning: "File edits are automatically accepted; other side effects remain subject to WorkBuddy permissions." };
  return { level: "normal", warning: `WorkBuddy permission mode: ${mode}.` };
}

function defaultStatePath(): string {
  const base = process.env.LOCALAPPDATA ?? process.env.TEMP ?? process.cwd();
  return resolve(base, "workbuddy-subagent-bridge", "tasks.json");
}

function sanitizeSessionResult(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("task" in value) || !("text" in value) || !("updates" in value)) return value;
  const result = value as { task: unknown; text: unknown; updates: unknown };
  const updates = Array.isArray(result.updates) ? result.updates : [];
  const updateKinds = [...new Set(updates.flatMap((item): string[] => {
    if (!item || typeof item !== "object" || !("update" in item)) return [];
    const update = (item as { update?: unknown }).update;
    if (!update || typeof update !== "object" || !("sessionUpdate" in update)) return [];
    const kind = (update as { sessionUpdate?: unknown }).sessionUpdate;
    return typeof kind === "string" ? [kind] : [];
  }))];
  const { updates: _updates, ...publicResult } = value as Record<string, unknown>;
  return { ...publicResult, updateCount: updates.length, updateKinds };
}
