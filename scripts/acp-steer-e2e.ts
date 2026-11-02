// The custom-ACP steer opt-in, end to end on the real modules — no Electron, no network:
// `provider-fakes/agents/custom-steer.ts` (FAKE_STEER=1) advertises `"_meta": { "steer": true }` in
// its initialize answer and answers `_openbot/steer`. Check agent reads the extension, the store
// persists the user's choice, and the `acp` driver's router steers a message into the running turn
// of the flagged agent: the fake's log shows `_openbot/steer` before the turn ends, and the turn's
// answer carries the steered text. The unflagged agent is refused before anything is sent.
// `bun run test:acp:steer`. Writes .openbot-build/acp-steer-e2e/report.json.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { agentSteers } from "@openbot/contracts/ipc";
import { checkAcpAgent } from "../src/backend/acp-agent-check";
import type { AgentClient } from "../src/backend/agent-client";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { type AppServerNotification, getRecord, getString, isRecord } from "../src/backend/protocol";
import { requireProviderDriver } from "../src/backend/provider-drivers";
import { CustomAgentStore } from "../src/main/custom-agent-store";
import { installFakeAgent, readJsonl, startThread, stopClients, xorCipher } from "./provider-fakes/host";

const OUT = resolve(import.meta.dirname, "../.openbot-build/acp-steer-e2e");
const FLAGGED = "steerf";
const PLAIN = "queuef";
const TURN_TIMEOUT_MS = 20_000;

interface LogEntry {
  event: string;
  sessionId?: string;
  messageId?: string;
  text?: string;
  content?: string[];
}

interface Report {
  checks?: { flagged: boolean; plain: boolean };
  store?: { savedWithFlag: boolean; keptOverFlaglessSave: boolean; plain: boolean };
  choice?: { onSteers: boolean; offQueues: boolean; restored: boolean };
  steered?: { turnId: string; reply: string; status: string | null; steer: LogEntry };
  plainRefused?: { refused: string; reply: string; unexpectedSteers: number };
  passed: boolean;
}
const report: Report = { passed: false };
const clients: AgentClient[] = [];

const root = await mkdtemp(join(tmpdir(), "openbot-acp-steer-"));
try {
  const log = join(root, "fake.jsonl");
  const binFlagged = join(root, "bin", "fake-steer");
  const binPlain = join(root, "bin", "fake-plain");
  await installFakeAgent(binFlagged, "custom-steer", { FAKE_STEER: "1", FAKE_LOG: log });
  await installFakeAgent(binPlain, "custom-steer", { FAKE_LOG: log });

  // 1. Check agent: the extension shows on the flagged fake and nowhere else.
  const checkFlagged = await runCauseEffect(checkAcpAgent({ executable: binFlagged, args: [], env: {} }));
  const checkPlain = await runCauseEffect(checkAcpAgent({ executable: binPlain, args: [], env: {} }));
  report.checks = { flagged: checkFlagged.steer, plain: checkPlain.steer };
  assert.equal(checkFlagged.steer, true, "Check agent misses _meta.steer.");
  assert.equal(checkPlain.steer, false, "A plain agent is read as steerable.");

  // 2. The store: saved with the flag, kept over a save that does not name it, absent by default.
  const store = new CustomAgentStore({ path: join(root, "custom-agents.json"), cipher: xorCipher });
  await runCauseEffect(store.load());
  const saveBase: { name: string; command: string; args: string[]; env: { name: string; value: string }[] } = {
    name: "probe",
    command: "",
    args: [],
    env: [],
  };
  await runCauseEffect(store.save({ ...saveBase, id: FLAGGED, command: binFlagged, usagePrompt: null, steer: true }));
  await runCauseEffect(store.save({ ...saveBase, id: PLAIN, command: binPlain, usagePrompt: null }));
  const savedWithFlag = store.configs().find((agent) => agent.id === FLAGGED)?.steer === true;
  // As a registry install or an older caller does.
  await runCauseEffect(store.save({ ...saveBase, id: FLAGGED, command: binFlagged, usagePrompt: null }));
  const keptOverFlaglessSave = store.configs().find((agent) => agent.id === FLAGGED)?.steer === true;
  report.store = {
    savedWithFlag,
    keptOverFlaglessSave,
    plain: store.configs().find((agent) => agent.id === PLAIN)?.steer === true,
  };
  assert.equal(savedWithFlag, true);
  assert.equal(keptOverFlaglessSave, true, "A save without the field reset the flag.");
  assert.equal(report.store.plain, false, "The plain fake gained a flag.");

  // 2b. The saved value is the user's choice itself: setting it on the plain fake resolves steer
  // for it, clearing it on the flagged fake resolves deferred, and restoring it steers again.
  const resolves = (id: string) => agentSteers({ provider: "acp", model: `${id}/default` }, store.configs());
  await runCauseEffect(store.save({ ...saveBase, id: PLAIN, command: binPlain, usagePrompt: null, steer: true }));
  const onSteers = resolves(PLAIN) === true;
  await runCauseEffect(store.save({ ...saveBase, id: FLAGGED, command: binFlagged, usagePrompt: null, steer: false }));
  const offQueues = resolves(FLAGGED) === false;
  // Restore the flagged fake for the steer of part 3.
  await runCauseEffect(store.save({ ...saveBase, id: FLAGGED, command: binFlagged, usagePrompt: null, steer: true }));
  const restored = resolves(FLAGGED) === true;
  report.choice = { onSteers, offQueues, restored };
  assert.equal(onSteers, true, "The saved choice did not turn steering on for the plain fake.");
  assert.equal(offQueues, true, "The saved choice did not hold the flagged fake to queueing.");
  assert.equal(restored, true, "Restoring the choice did not return the flagged fake's steering.");
  // Part 4 wants the plain fake as its saved default: no flag.
  await runCauseEffect(store.save({ ...saveBase, id: PLAIN, command: binPlain, usagePrompt: null, steer: false }));

  // 3. The driver: a message steered into the flagged agent's running turn answers it.
  const context = {
    apiKey: () => null,
    customProviders: () => [],
    mcpServers: () => [],
    customAgents: () => store.configs(),
  };
  const driver = requireProviderDriver("acp");
  const cli = await runCauseEffect(driver.resolveCli());
  const client = driver.createClient(cli, 20_000, context, undefined);
  clients.push(client);
  client.start();

  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const model = `${FLAGGED}/default`;
  const thread = await startThread(client, { model, cwd: workspace });

  let reply = "";
  let listener: ((notification: AppServerNotification) => void) | undefined;
  const done = new Promise<{ reply: string; status: string | null }>((finish, fail) => {
    const timer = setTimeout(() => fail(new Error("The turn did not complete.")), TURN_TIMEOUT_MS);
    listener = (notification) => {
      if (getString(notification.params, "threadId") !== thread) return;
      if (notification.method === "item/completed" && isRecord(notification.params))
        reply += getString(notification.params.item, "text") ?? "";
      if (notification.method === "turn/completed") {
        clearTimeout(timer);
        if (listener) client.off("notification", listener);
        finish({ reply, status: getString(getRecord(notification.params, "turn"), "status") });
      }
    };
    client.on("notification", listener);
  });
  done.catch(() => undefined);
  const started = await runCauseEffect(
    client.request(
      "turn/start",
      { threadId: thread, model, input: [{ type: "text", text: "work", text_elements: [] }] },
      (value) => value,
    ),
  );
  const turnId = getString(getRecord(started, "turn"), "id");
  assert.ok(turnId, "turn/start answers no turn id.");

  const steeredTurn = await runCauseEffect(
    client.request(
      "turn/steer",
      {
        threadId: thread,
        expectedTurnId: turnId,
        clientUserMessageId: "delivery-1",
        input: [{ type: "text", text: "use the other branch", text_elements: [] }],
      },
      (value) => getString(value, "turnId"),
    ),
  );
  assert.equal(steeredTurn, turnId);
  const finished = await done;
  const entries = await readJsonl<LogEntry>(log);
  const steer = entries.find((entry) => entry.event === "steer");
  assert.ok(steer, "The steer must send _openbot/steer.");
  assert.equal(steer.messageId, "delivery-1");
  assert.equal(steer.text, "use the other branch");
  assert.deepEqual(steer.content, ["text"]);
  assert.equal(finished.status, "completed");
  assert.match(finished.reply, /steered: use the other branch/u);
  assert.equal(
    entries.filter((entry) => entry.event === "prompt" && entry.sessionId === steer.sessionId).length,
    1,
    "The steer must not send a second prompt.",
  );
  report.steered = { turnId, reply: finished.reply, status: finished.status, steer };

  // 4. The plain agent: the steer is refused before anything is sent, and the turn goes on.
  const plainThread = await startThread(client, { model: `${PLAIN}/default`, cwd: workspace });
  let plainReplyText = "";
  let plainListener: ((notification: AppServerNotification) => void) | undefined;
  const plainDone = new Promise<string>((finish, fail) => {
    const timer = setTimeout(() => fail(new Error("The plain turn did not complete.")), TURN_TIMEOUT_MS);
    plainListener = (notification) => {
      if (getString(notification.params, "threadId") !== plainThread) return;
      if (notification.method === "item/completed" && isRecord(notification.params))
        plainReplyText += getString(notification.params.item, "text") ?? "";
      if (notification.method === "turn/completed") {
        clearTimeout(timer);
        if (plainListener) client.off("notification", plainListener);
        finish(plainReplyText);
      }
    };
    client.on("notification", plainListener);
  });
  plainDone.catch(() => undefined);
  const plainStarted = await runCauseEffect(
    client.request(
      "turn/start",
      { threadId: plainThread, model: `${PLAIN}/default`, input: [{ type: "text", text: "work", text_elements: [] }] },
      (value) => value,
    ),
  );
  const plainTurnId = getString(getRecord(plainStarted, "turn"), "id");
  assert.ok(plainTurnId, "The plain turn/start answers no turn id.");
  const refused = await runCauseEffect(
    client.request(
      "turn/steer",
      {
        threadId: plainThread,
        expectedTurnId: plainTurnId,
        clientUserMessageId: "delivery-2",
        input: [{ type: "text", text: "steer the plain agent", text_elements: [] }],
      },
      (value) => getString(value, "turnId"),
    ),
  ).then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  assert.ok(refused !== null, "The unflagged agent must refuse the steer.");
  const plainReply = await plainDone;
  assert.match(plainReply, /done without steering/u);
  const unexpectedSteers = (await readJsonl<LogEntry>(log)).filter((entry) => entry.event === "unexpected-steer");
  assert.equal(unexpectedSteers.length, 0, "The refused steer must not reach the agent.");
  report.plainRefused = { refused, reply: plainReply, unexpectedSteers: unexpectedSteers.length };

  report.passed = true;
} finally {
  await stopClients(clients);
  await rm(root, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
