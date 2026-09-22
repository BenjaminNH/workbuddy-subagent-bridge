import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AcpClient, extractUpdateText } from "./acp-client.js";

const fakeCli = String.raw`import readline from "node:readline";
const output = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    output({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, agentInfo: { name: "fake" } } });
  } else if (request.method === "session/new") {
    output({ jsonrpc: "2.0", id: request.id, result: { sessionId: "session-test", models: [{ modelId: "hy4" }] } });
  } else if (request.method === "session/load") {
    output({ jsonrpc: "2.0", id: request.id, result: {} });
  } else if (request.method === "session/prompt") {
    output({ jsonrpc: "2.0", method: "session/update", params: { sessionId: request.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "streamed " }] } } });
    output({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "reply" }] } });
  } else if (request.method === "session/cancel") {
    output({ jsonrpc: "2.0", id: request.id, result: {} });
  }
});`;

async function clientWithFakeCli(): Promise<{ client: AcpClient; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "workbuddy-acp-"));
  const cli = join(directory, "fake-cli.mjs");
  await writeFile(cli, fakeCli, "utf8");
  const client = await AcpClient.start({ cliPath: cli, cwd: directory, permissionMode: "plan" });
  return { client, directory };
}

describe("AcpClient", () => {
  it("performs initialize, session/new, prompt update parsing, and cancel over NDJSON", async () => {
    const { client, directory } = await clientWithFakeCli();
    try {
      await expect(client.newSession()).resolves.toEqual({ sessionId: "session-test", models: [{ modelId: "hy4" }] });
      const result = await client.prompt("session-test", "hello");
      expect(result.text).toBe("reply");
      expect(result.updates).toHaveLength(1);
      expect(result.updates[0]).toMatchObject({ sessionId: "session-test", update: { content: [{ type: "text", text: "streamed " }] } });
      expect(extractUpdateText(result.updates)).toBe("streamed ");
      await expect(client.cancel("session-test")).resolves.toBeUndefined();
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("loads a persisted session and rejects JSON-RPC errors", async () => {
    const { client, directory } = await clientWithFakeCli();
    try {
      await expect(client.loadSession("session-test")).resolves.toBeUndefined();
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not expose private reasoning chunks as the response text", async () => {
    const { client, directory } = await clientWithFakeCli();
    try {
      const result = await client.prompt("session-test", "hello");
      expect(extractUpdateText([{ raw: null, update: { sessionUpdate: "agent_thought_chunk", content: [{ type: "text", text: "private" }] } }, ...result.updates])).toBe("streamed ");
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
