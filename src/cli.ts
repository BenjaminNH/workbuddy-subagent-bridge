#!/usr/bin/env node
import { access, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDoctor } from "./doctor.js";

const command = process.argv[2] ?? "doctor";

if (command === "doctor") {
  const report = await runDoctor();
  console.log(JSON.stringify(report, null, 2));
  if (!report.node.ok || !report.npm.ok || !report.workbuddy.ok || !report.data.ok || !report.cli.ok || !report.acp.ok || !report.models.ok) process.exitCode = 1;
} else if (command === "init") {
  await initCommand(process.argv.slice(3));
} else {
  console.error("Unknown command: " + command);
  process.exitCode = 2;
}

async function initCommand(args: string[]): Promise<void> {
  const client = valueAfter(args, "--client") ?? "codex";
  if (client !== "codex") throw new Error("Only --client codex is supported in this version");
  const output = resolve(valueAfter(args, "--output") ?? join(process.cwd(), "workbuddy-mcp.json"));
  const force = args.includes("--force");
  if (!force) {
    try {
      await access(output);
      throw new Error("Refusing to overwrite existing file; pass --force: " + output);
    } catch (error) {
      if (error instanceof Error && !error.message.includes("ENOENT")) throw error;
    }
  }
  const serverEntry = resolve(dirname(fileURLToPath(import.meta.url)), "index.js");
  const config = {
    mcpServers: {
      "workbuddy-subagent-bridge": {
        command: process.execPath,
        args: [serverEntry]
      }
    }
  };
  await writeFile(output, JSON.stringify(config, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ client, output, config }, null, 2));
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
