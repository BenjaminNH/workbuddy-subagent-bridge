import { readFile } from "node:fs/promises";
import { atomicWriteJson, now } from "./utils.js";
import type { TaskRecord, TaskStatus } from "./types.js";

interface RegistryFile {
  version: 1;
  tasks: Record<string, TaskRecord>;
}

export class TaskRegistry {
  private queue: Promise<void> = Promise.resolve();
  private state: RegistryFile = { version: 1, tasks: {} };
  private loaded = false;

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    await this.withLock(async () => {
      if (this.loaded) return;
      try {
        const raw = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<RegistryFile>;
        if (raw.version === 1 && raw.tasks && typeof raw.tasks === "object") {
          this.state = { version: 1, tasks: raw.tasks as Record<string, TaskRecord> };
        }
      } catch (error: unknown) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (code !== "ENOENT") throw error;
      }
      this.loaded = true;
    });
  }

  async get(taskId: string): Promise<TaskRecord | undefined> {
    await this.load();
    return this.state.tasks[taskId];
  }

  async list(): Promise<TaskRecord[]> {
    await this.load();
    return Object.values(this.state.tasks).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async put(task: TaskRecord): Promise<TaskRecord> {
    await this.load();
    return this.withLock(async () => {
      task.updatedAt = now();
      this.state.tasks[task.taskId] = structuredClone(task);
      await atomicWriteJson(this.filePath, this.state);
      return structuredClone(task);
    });
  }

  async update(taskId: string, patch: Partial<TaskRecord> & { status?: TaskStatus }): Promise<TaskRecord> {
    await this.load();
    return this.withLock(async () => {
      const current = this.state.tasks[taskId];
      if (!current) throw new Error(`Unknown task: ${taskId}`);
      const next = { ...current, ...patch, taskId, updatedAt: now() };
      this.state.tasks[taskId] = next;
      await atomicWriteJson(this.filePath, this.state);
      return structuredClone(next);
    });
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
