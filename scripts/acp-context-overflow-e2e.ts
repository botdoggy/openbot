// A custom ACP session whose prompt failed with context-overflow wording is retired, and the
// message is sent again one time in a new session. A non-overflow failure keeps its session and is
// not retried. The check runs the real AgentService on a temporary profile; the custom agents are
// the fake in `provider-fakes/agents/context-overflow.ts`, with no network or account.
// `bun run test:acp-context-overflow`. Writes .openbot-build/acp-context-overflow-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { installFakeAgent, readJsonl } from "./provider-fakes/host";

const OUT = resolve(import.meta.dirname, "../.openbot-build/acp-context-overflow-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-acp-context-overflow-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const logPath = join(root, "fake-acp.jsonl");
const statePath = join(root, "fake-state.json");
const executable = join(root, "bin", "fake-context-overflow");

// The stores read the home folder when the service modules load.
process.env.HOME = home;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");

interface LogEntry {
  event: string;
  pid: number;
  agentId?: string;
  method?: string;
  sessionId?: string | null;
  hasTrigger?: boolean;
  overflow?: boolean;
}

interface PromptReport {
  prompts: { pid: number; sessionId: string | null; hasTrigger: boolean | null }[];
  sessions: (string | null)[];
  failures: (string | null)[];
  closes: (string | null)[];
}

interface Report {
  overflow?: PromptReport & { deliveryStatus: string | null };
  otherFailure?: PromptReport & { deliveryStatus: string | null };
  passed: boolean;
  error?: string;
}

const report: Report = { passed: false };
const unused = () => Effect.die(new Error("Not used by this check."));
const browser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
};

/** Waits for a service state or a fake-agent log entry. */
async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((settle) => setTimeout(settle, 25));
  }
}

/** Creates an agent whose first chat message asks the fake to fail, and waits for its final state. */
async function createFailureAgent(
  agents: InstanceType<typeof AgentService>,
  name: string,
  model: string,
): Promise<{ agentId: string; status: string | null }> {
  const agent = await runCauseEffect(
    agents.createAgent({
      name,
      description: "Checks ACP session failure recovery.",
      avatarSeed: name.toLowerCase().replaceAll(" ", "-"),
      avatarHue: null,
      provider: "acp",
      model,
      initialMessage: `cause failure for ${name}`,
    }),
  );
  await waitFor(`${name}: the initial delivery`, () => agents.listQueue(agent.id).deliveries.length > 0);
  await waitFor(`${name}: the initial delivery to settle`, () =>
    agents
      .listQueue(agent.id)
      .deliveries.every(({ status }) => status === "completed" || status === "failed" || status === "interrupted"),
  );
  return { agentId: agent.id, status: agents.listQueue(agent.id).deliveries[0]?.status ?? null };
}

function promptsFor(agentId: string, entries: readonly LogEntry[]): PromptReport {
  const agentEntries = entries.filter((entry) => entry.agentId === agentId);
  const prompts = agentEntries
    .filter((entry) => entry.event === "prompt")
    .map((entry) => ({ pid: entry.pid, sessionId: entry.sessionId ?? null, hasTrigger: entry.hasTrigger ?? null }));
  const promptPids = new Set(prompts.map((entry) => entry.pid));
  const promptSessions = new Set(prompts.map((entry) => entry.sessionId));
  return {
    prompts,
    sessions: agentEntries
      .filter((entry) => entry.method === "session/new" && promptPids.has(entry.pid))
      .map((entry) => entry.sessionId ?? null),
    failures: agentEntries.filter((entry) => entry.event === "failed").map((entry) => entry.sessionId ?? null),
    closes: agentEntries
      .filter(
        (entry) =>
          entry.method === "session/close" && entry.sessionId !== undefined && promptSessions.has(entry.sessionId),
      )
      .map((entry) => entry.sessionId ?? null),
  };
}

let database: InstanceType<typeof OpenBotDatabase> | undefined;
let agents: InstanceType<typeof AgentService> | undefined;
try {
  await installFakeAgent(executable, "context-overflow", { FAKE_LOG: logPath });
  database = new OpenBotDatabase(userData);
  const store = new AgentStore(userData, home, database);
  const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
  const agentConfig = (id: string, failure: string) => ({
    id,
    name: id === "overflow" ? "Overflow" : "Other failure",
    command: executable,
    args: [],
    env: [
      { name: "FAKE_LOG", value: logPath },
      { name: "FAKE_STATE", value: statePath },
      { name: "FAKE_AGENT_ID", value: id },
      { name: "FAKE_FAILURE", value: failure },
    ],
    usagePrompt: null,
  });
  agents = new AgentService({
    store,
    mailbox,
    browser,
    preferredProvider: "acp",
    offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "acp"),
    timezone: () => "UTC",
    credentials: {
      apiKey: () => null,
      customProviders: () => [],
      mcpServers: () => [],
      customAgents: () => [agentConfig("overflow", "overflow"), agentConfig("other", "other")],
    },
  });
  await runCauseEffect(agents.initialize());

  // The failed prompt is requeued and retried once, after the refused session is dropped.
  const overflow = await createFailureAgent(agents, "Overflow agent", "overflow/default");
  assert.equal(overflow.status, "completed", "The overflow turn did not recover.");
  const entries = await readJsonl<LogEntry>(logPath);
  const overflowPrompts = promptsFor("overflow", entries);
  report.overflow = { ...overflowPrompts, deliveryStatus: overflow.status };
  assert.equal(overflowPrompts.prompts.length, 2, "Overflow recovery did not send exactly one retry.");
  assert.equal(overflowPrompts.failures.length, 1, "The fake did not fail exactly one overflow prompt.");
  assert.notEqual(
    overflowPrompts.prompts[0]?.sessionId,
    overflowPrompts.prompts[1]?.sessionId,
    "The retry reused the refused session.",
  );
  assert.ok(
    overflowPrompts.sessions.includes(overflowPrompts.prompts[1]?.sessionId ?? null),
    "The retry did not open a replacement session.",
  );
  assert.ok(
    overflowPrompts.closes.includes(overflowPrompts.prompts[0]?.sessionId ?? null),
    "The overflow session was not closed.",
  );
  assert.equal(overflowPrompts.prompts[1]?.hasTrigger, true, "The retry lost the failed message.");

  // A prompt failure that is not context overflow is not retired or retried.
  const other = await createFailureAgent(agents, "Other failure agent", "other/default");
  assert.equal(other.status, "failed", "A non-overflow failure did not remain a failure.");
  const afterOther = await readJsonl<LogEntry>(logPath);
  const otherPrompts = promptsFor("other", afterOther);
  report.otherFailure = { ...otherPrompts, deliveryStatus: other.status };
  assert.equal(otherPrompts.prompts.length, 1, "A non-overflow failure was retried.");
  const otherPromptSessions = otherPrompts.sessions.filter((sessionId) =>
    otherPrompts.prompts.some((prompt) => prompt.sessionId === sessionId),
  );
  assert.equal(otherPromptSessions.length, 1, "A non-overflow failure opened another prompt session.");
  assert.equal(otherPrompts.closes.length, 0, "A non-overflow failure retired its session.");

  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  if (agents) await runCauseEffect(agents.stop()).catch(() => undefined);
  database?.close();
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.passed ? 0 : 1;
