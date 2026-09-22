import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BridgeService } from "./service.js";
import { TaskRegistry } from "./task-registry.js";

const cli = String.raw`import readline from "node:readline";
const output = (value) => process.stdout.write(JSON.stringify(value) + "\n");
if (process.argv.includes("-p")) {
  output({ result: "CLI_FALLBACK_OK" });
} else {
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      output({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, agentInfo: { name: "fake" } } });
    } else if (request.method === "session/new") {
      output({ jsonrpc: "2.0", id: request.id, result: { sessionId: "service-session" } });
    } else if (request.method === "session/load") {
      output({ jsonrpc: "2.0", id: request.id, result: {} });
    } else if (request.method === "session/prompt") {
      output({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "ACP_OK" }] } });
    }
  });
}`;

const fallbackOnlyCli = String.raw`if (process.argv.includes("--acp")) process.exit(2);
process.stdout.write(JSON.stringify({ result: "AUTO_FALLBACK_OK" }) + "\n");`;

const arrayOutputCli = String.raw`if (process.argv.includes("-p")) {
  process.stdout.write(JSON.stringify([{ type: "message", text: "intermediate" }, { type: "result", result: "CLI_ARRAY_OK" }]) + "\n");
} else process.exit(2);`;

const permissionCli = String.raw`import readline from "node:readline";
const output = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") output({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1 } });
  else if (request.method === "session/new") output({ jsonrpc: "2.0", id: request.id, result: { sessionId: "permission-session" } });
  else if (request.method === "session/prompt") output({ jsonrpc: "2.0", id: 900, method: "session/request_permission", params: { tool: "shell", command: "echo test", options: [{ optionId: "allow_once" }, { optionId: "reject" }] } });
  else if (request.id === 900) output({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "PERMISSION_OK" }] } });
});`;

const catalogCli = String.raw`import readline from "node:readline";
const output = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") output({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1 } });
  else if (request.method === "session/new") output({ jsonrpc: "2.0", id: request.id, result: { sessionId: "catalog-session", models: { availableModels: [{ modelId: "hy4-preview", name: "Hy4 preview", _meta: { credits: "0.29" } }] } } });
});`;

async function fixture(script = cli): Promise<{ service: BridgeService; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "workbuddy-service-"));
  const cliPath = join(directory, "fake-cli.mjs");
  await writeFile(cliPath, script, "utf8");
  const registry = new TaskRegistry(join(directory, "tasks.json"));
  await registry.load();
  return { service: new BridgeService(registry, cliPath), directory };
}

describe("BridgeService", () => {
  it("runs a CLI fallback as a one-shot task and refuses follow-up prompts", async () => {
    const { service, directory } = await fixture();
    try {
      const result = await service.start({ cwd: directory, prompt: "run once", backend: "cli", permissionMode: "bypassPermissions" });
      expect(result.text).toBe("CLI_FALLBACK_OK");
      expect(result.task.backend).toBe("cli");
      expect(result.task.status).toBe("awaiting_review");
      expect(result.task.permissionMode).toBe("bypassPermissions");
      await expect(service.send({ taskId: result.task.taskId, message: "again" })).rejects.toThrow("one-shot");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("falls back before submission when ACP preflight fails", async () => {
    const { service, directory } = await fixture(fallbackOnlyCli);
    try {
      const result = await service.start({ cwd: directory, prompt: "run once" });
      expect(result.text).toBe("AUTO_FALLBACK_OK");
      expect(result.task.backend).toBe("cli");
      expect(result.task.status).toBe("awaiting_review");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("extracts the final result from CodeBuddy CLI JSON event arrays", async () => {
    const { service, directory } = await fixture(arrayOutputCli);
    try {
      const result = await service.start({ cwd: directory, prompt: "run array output", backend: "cli" });
      expect(result.text).toBe("CLI_ARRAY_OK");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps an ACP task on one session for the initial prompt", async () => {
    const { service, directory } = await fixture();
    try {
      const result = await service.start({ cwd: directory, prompt: "run", modelId: "hy4-preview", permissionMode: "plan", waitForCompletion: true });
      expect(result.text).toBe("ACP_OK");
      expect(result.task.backend).toBe("acp");
      expect(result.task.sessionId).toBe("service-session");
      expect(result.task.status).toBe("awaiting_review");
      await service.close(result.task.taskId);
      const resumed = await service.send({ taskId: result.task.taskId, message: "continue after close" });
      expect(resumed.text).toBe("ACP_OK");
      expect(resumed.task.status).toBe("awaiting_review");
      await service.close(result.task.taskId);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("loads the persisted session when a new bridge instance sends feedback", async () => {
    const first = await fixture();
    const secondRegistry = new TaskRegistry(join(first.directory, "tasks.json"));
    const second = new BridgeService(secondRegistry, join(first.directory, "fake-cli.mjs"));
    let taskId = "";
    try {
      const started = await first.service.start({ cwd: first.directory, prompt: "initial", modelId: "hy4-preview", waitForCompletion: true });
      taskId = started.task.taskId;
      const resumed = await second.send({ taskId, message: "feedback" });
      expect(resumed.text).toBe("ACP_OK");
      expect(resumed.task.sessionId).toBe(started.task.sessionId);
    } finally {
      if (taskId) {
        await second.close(taskId).catch(() => undefined);
        await first.service.close(taskId).catch(() => undefined);
      }
      await rm(first.directory, { recursive: true, force: true });
    }
  });

  it("surfaces an ACP permission request and resumes after the main agent replies", async () => {
    const { service, directory } = await fixture(permissionCli);
    try {
      const started = await service.start({ cwd: directory, prompt: "needs permission", modelId: "hy4-preview" });
      let taskId = started.task.taskId;
      expect(started.text).toBe("");
      expect(started.task.status).toBe("running");
      let pending: { requestId: string }[] | undefined;
      for (let index = 0; index < 50; index += 1) {
        const tasks = await service.listTasks();
        taskId = tasks[0]?.taskId ?? taskId;
        pending = tasks[0]?.pendingPermissions;
        if (pending?.length) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(pending).toHaveLength(1);
      await service.replyPermission(taskId, pending![0].requestId, { outcome: { outcome: "selected", optionId: "allow_once" } });
      for (let index = 0; index < 50 && !service.hasReport(taskId); index += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      const result = await service.report(taskId);
      expect(result.text).toBe("PERMISSION_OK");
      await service.close(taskId);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("adds source and fetchedAt metadata to the model catalog", async () => {
    const { service, directory } = await fixture(catalogCli);
    try {
      const models = await service.listModels();
      expect(models[0]).toMatchObject({ modelId: "hy4-preview", source: "codebuddy-acp session/new" });
      expect(models[0].fetchedAt).toEqual(expect.any(String));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
