import { isRecord } from "./utils.js";

/**
 * Minimal stderr logger for the stdio MCP process. Never pass prompts, result
 * bodies, credentials, or raw ACP payloads to this function.
 */
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  const safeFields = Object.fromEntries(Object.entries(fields).filter(([, value]) => isSafeLogValue(value)));
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...safeFields })}\n`);
}

function isSafeLogValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isSafeLogValue);
  if (isRecord(value)) return false;
  return false;
}
