import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function now(): string {
  return new Date().toISOString();
}

export function newTaskId(): string {
  return `wb-${randomUUID()}`;
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value) && value.type === "text" && typeof value.text === "string") return value.text;
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (isRecord(item) && item.type === "text" && typeof item.text === "string") return item.text;
      return "";
    })
    .filter(Boolean)
    .join("");
}
