// OpenBot offers ACP's `session.compaction` client capability, so an agent that compacts can send
// `compaction_update`; the real ACP client turns its completed update into OpenBot's compaction
// notification, which the chat's context surface consumes. The fake sends the update only after
// seeing the capability, so this branch must differ from a client that never asks for it.
// `bun run test:acp-compaction`. Writes .openbot-build/acp-compaction-e2e/report.json.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentClient } from "../src/backend/agent-client";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { type AppServerNotification, getString, isRecord } from "../src/backend/protocol";
import { requireProviderDriver } from "../src/backend/provider-drivers";
import { installFakeAgent, readJsonl, runTurn, startThread, stopClients } from "./provider-fakes/host";

const OUT = resolve(import.meta.dirname, "../.openbot-build/acp-compaction-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-acp-compaction-"));
const logPath = join(root, "fake.jsonl");
const executable = join(root, "bin", "fake-compaction");
const workspace = join(root, "workspace");

interface LogEntry {
  event: string;
  sessionId?: string;
  compactionOffered?: boolean;
}

interface Report {
  offered?: boolean;
  fakeSentCompaction?: boolean;
  openbotCompactionNotification?: boolean;
  reply?: string;
  turnStatus?: string;
  threadSessionId?: string;
  passed: boolean;
  error?: string;
}

const report: Report = { passed: false };
const clients: AgentClient[] = [];

try {
  await mkdir(workspace, { recursive: true });
  await installFakeAgent(executable, "compaction", { FAKE_LOG: logPath });
  const driver = requireProviderDriver("acp");
  const context = {
    apiKey: () => null,
    customProviders: () => [],
    mcpServers: () => [],
    customAgents: () => [
      {
        id: "compact",
        name: "Compaction",
        command: executable,
        args: [],
        env: [{ name: "FAKE_LOG", value: logPath }],
        usagePrompt: null,
      },
    ],
  };
  const cli = await runCauseEffect(driver.resolveCli());
  const client = driver.createClient(cli, 20_000, context, undefined);
  clients.push(client);
  client.start();

  const thread = await startThread(client, { model: "compact/default", cwd: workspace });
  const notifications: AppServerNotification[] = [];
  const listen = (notification: AppServerNotification): void => {
    notifications.push(notification);
  };
  client.on("notification", listen);
  const turn = await runTurn(client, thread, { model: "compact/default", text: "compact after this" });
  client.off("notification", listen);
  assert.equal(turn.error, null, `The compaction prompt failed: ${turn.reply}`);
  assert.equal(turn.reply, "Done.");
  report.reply = turn.reply;
  report.threadSessionId = thread.split(":").at(-1);

  const entries = await readJsonl<LogEntry>(logPath);
  const offered = entries.filter((entry) => entry.event === "initialize" && entry.compactionOffered === true);
  const fakeSent = entries.find((entry) => entry.event === "compaction" && entry.sessionId === report.threadSessionId);
  assert.ok(offered.length > 0, "The fake never saw session.compaction from the client.");
  assert.ok(fakeSent, "The fake did not send compaction_update for the thread.");
  const openbotCompaction = notifications.some(
    (notification) =>
      notification.method === "openbot/context-compaction" &&
      isRecord(notification.params) &&
      getString(notification.params, "threadId") === thread &&
      getString(notification.params, "status") === "completed",
  );
  assert.ok(openbotCompaction, "The ACP client did not report the completed compaction to OpenBot.");
  report.offered = true;
  report.fakeSentCompaction = true;
  report.openbotCompactionNotification = true;
  report.turnStatus = turn.status ?? "not recorded";
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  await stopClients(clients);
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.passed ? 0 : 1;
