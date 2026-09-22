import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const execFileAsync = promisify(execFile);

export interface DoctorReport {
  node: { ok: boolean; version: string };
  npm: { ok: boolean; version?: string; error?: string };
  workbuddy: { ok: boolean; path: string; error?: string };
  data: { ok: boolean; path: string; error?: string };
  cli: { ok: boolean; path: string; version?: string; error?: string };
  acp: { ok: boolean; transport: "stdio"; error?: string };
  models: { ok: boolean; count?: number; error?: string };
}

export function defaultCliPath(): string {
  if (process.env.WORKBUDDY_CLI_PATH) return process.env.WORKBUDDY_CLI_PATH;
  const root = process.env.WORKBUDDY_HOME ?? "D:\\WorkBuddy";
  return resolve(root, "resources", "app.asar.unpacked", "cli", "bin", "codebuddy");
}

export async function runDoctor(cliPath = defaultCliPath()): Promise<DoctorReport> {
  const workbuddyPath = process.env.WORKBUDDY_HOME ?? deriveWorkBuddyPath(cliPath);
  const dataPath = process.env.WORKBUDDY_DATA_DIR ?? join(homedir(), ".workbuddy");
  const report: DoctorReport = {
    node: { ok: Number(process.versions.node.split(".")[0]) >= 20, version: process.version },
    npm: { ok: false },
    workbuddy: { ok: false, path: workbuddyPath },
    data: { ok: false, path: dataPath },
    cli: { ok: false, path: cliPath },
    acp: { ok: false, transport: "stdio" },
    models: { ok: false }
  };
  try {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const version = await execFileAsync(npm, ["--version"], { timeout: 10_000, shell: process.platform === "win32" });
    report.npm = { ok: true, version: version.stdout.trim() };
  } catch (error) {
    report.npm.error = error instanceof Error ? error.message : String(error);
  }
  try {
    await access(workbuddyPath, constants.R_OK);
    report.workbuddy.ok = true;
  } catch (error) {
    report.workbuddy.error = error instanceof Error ? error.message : String(error);
  }
  try {
    await access(dataPath, constants.R_OK);
    report.data.ok = true;
  } catch (error) {
    report.data.error = error instanceof Error ? error.message : String(error);
  }
  try {
    await access(cliPath, constants.R_OK);
    const version = await execFileAsync(process.execPath, [cliPath, "--version"], { timeout: 10_000 });
    report.cli.ok = true;
    report.cli.version = version.stdout.trim();
  } catch (error) {
    report.cli.error = error instanceof Error ? error.message : String(error);
    return report;
  }
  try {
    const { AcpClient } = await import("./acp-client.js");
    const client = await AcpClient.start({ cliPath, cwd: process.cwd(), permissionMode: "plan", noSessionPersistence: true });
    report.acp.ok = true;
    try {
      const session = await client.newSession();
      const models = session.models;
      const availableModels = models && typeof models === "object" && models !== null && "availableModels" in models
        ? (models as { availableModels?: unknown }).availableModels
        : undefined;
      report.models = { ok: Array.isArray(availableModels), count: Array.isArray(availableModels) ? availableModels.length : 0 };
      if (!report.models.ok) report.models.error = "ACP session/new returned no availableModels";
    } catch (error) {
      report.models.error = error instanceof Error ? error.message : String(error);
    }
    await client.close();
  } catch (error) {
    report.acp.error = error instanceof Error ? error.message : String(error);
  }
  return report;
}

function deriveWorkBuddyPath(cliPath: string): string {
  let current = cliPath;
  for (let index = 0; index < 5; index += 1) current = dirname(current);
  return current;
}
