import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TaskRegistry } from "./task-registry.js";
import type { TaskRecord } from "./types.js";

function task(taskId: string): TaskRecord {
  const timestamp = new Date(2026, 0, 1).toISOString();
  return {
    taskId,
    backend: "acp",
    cwd: "C:/project",
    permissionMode: "plan",
    status: "created",
    createdAt: timestamp,
    updatedAt: timestamp,
    submitted: false
  };
}

describe("TaskRegistry", () => {
  it("persists records atomically and loads them in a new registry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workbuddy-registry-"));
    const path = join(directory, "tasks.json");
    const first = new TaskRegistry(path);

    const stored = await first.put(task("task-1"));
    expect(stored.taskId).toBe("task-1");
    expect(stored.updatedAt).not.toBe(task("task-1").updatedAt);

    const second = new TaskRegistry(path);
    await expect(second.get("task-1")).resolves.toMatchObject({ taskId: "task-1", status: "created" });
    const raw = JSON.parse(await readFile(path, "utf8")) as { version: number; tasks: Record<string, TaskRecord> };
    expect(raw.version).toBe(1);
    expect(raw.tasks["task-1"].taskId).toBe("task-1");
  });

  it("serializes concurrent writes and preserves every task", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workbuddy-registry-"));
    const registry = new TaskRegistry(join(directory, "tasks.json"));

    await Promise.all(Array.from({ length: 12 }, (_, index) => registry.put(task(`task-${index}`))));
    const records = await registry.list();
    expect(records).toHaveLength(12);
    expect(new Set(records.map((record) => record.taskId)).size).toBe(12);
  });

  it("updates an existing task without mutating the caller's record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workbuddy-registry-"));
    const registry = new TaskRegistry(join(directory, "tasks.json"));
    const original = task("task-1");
    await registry.put(original);

    const updated = await registry.update("task-1", { status: "running", submitted: true });
    expect(updated).toMatchObject({ taskId: "task-1", status: "running", submitted: true });
    expect(original.status).toBe("created");
    await expect(registry.update("missing", { status: "failed" })).rejects.toThrow("Unknown task: missing");
  });
});
