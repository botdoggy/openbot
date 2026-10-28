// The custom-ACP concurrent-turns opt-in, end to end on the real modules — no Electron, no network:
// `provider-fakes/agents/concurrent.ts` advertises `"_meta": { "concurrentTurns": true }` in its
// initialize answer. Check agent reads the extension, the store persists it, and the `acp` driver's
// router runs the turns of two sessions of one process at the same time — a fast turn on a second
// session of a shared folder completes while a slow turn on the first session is still running.
// The flagged agent and one that advertises nothing go through the same store, so the flag survives
// a save that does not name it and defaults to absent.
// `bun run test:acp:concurrent-turns`. Writes .openbot-build/acp-concurrent-turns-e2e/report.json.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkAcpAgent } from "../src/backend/acp-agent-check";
import type { AgentClient } from "../src/backend/agent-client";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { requireProviderDriver } from "../src/backend/provider-drivers";
import { CustomAgentStore } from "../src/main/custom-agent-store";
import { installFakeAgent, readJsonl, runTurn, startThread, stopClients, xorCipher } from "./provider-fakes/host";

const OUT = resolve(import.meta.dirname, "../.openbot-build/acp-concurrent-turns-e2e");
const FLAGGED = "parfake";
const PLAIN = "serfake";
const SLOW_MS = 2_500;

interface LogEntry {
  event: string;
  sessionId?: string;
  slow?: boolean;
}

interface Report {
  checks?: { flagged: boolean; plain: boolean };
  store?: { savedWithFlag: boolean; keptOverFlaglessSave: boolean; plain: boolean };
  turns?: { fastBeatSlow: boolean; slowReply: string; fastReply: string };
  passed: boolean;
}
const report: Report = { passed: false };
const clients: AgentClient[] = [];

const root = await mkdtemp(join(tmpdir(), "openbot-acp-concurrent-turns-"));
try {
  const log = join(root, "fake.jsonl");
  const binFlagged = join(root, "bin", "fake-flagged");
  const binPlain = join(root, "bin", "fake-plain");
  await installFakeAgent(binFlagged, "concurrent", {
    FAKE_CONCURRENT: "1",
    FAKE_SLOW_MS: String(SLOW_MS),
    FAKE_LOG: log,
  });
  await installFakeAgent(binPlain, "concurrent", { FAKE_LOG: log });

  // 1. Check agent: the extension shows on the flagged fake and nowhere else.
  const checkFlagged = await runCauseEffect(checkAcpAgent({ executable: binFlagged, args: [], env: {} }));
  const checkPlain = await runCauseEffect(checkAcpAgent({ executable: binPlain, args: [], env: {} }));
  report.checks = { flagged: checkFlagged.concurrentTurns, plain: checkPlain.concurrentTurns };
  assert.equal(checkFlagged.concurrentTurns, true, "Check agent misses _meta.concurrentTurns.");
  assert.equal(checkPlain.concurrentTurns, false, "A plain agent is read as concurrent.");

  // 2. The store: saved with the flag, kept over a save that does not name it, absent by default.
  const store = new CustomAgentStore({ path: join(root, "custom-agents.json"), cipher: xorCipher });
  await runCauseEffect(store.load());
  const saveBase: { name: string; command: string; args: string[]; env: { name: string; value: string }[] } = {
    name: "probe",
    command: "",
    args: [],
    env: [],
  };
  await runCauseEffect(
    store.save({ ...saveBase, id: FLAGGED, command: binFlagged, usagePrompt: null, concurrentTurns: true }),
  );
  await runCauseEffect(store.save({ ...saveBase, id: PLAIN, command: binPlain, usagePrompt: null }));
  const savedWithFlag = store.configs().find((agent) => agent.id === FLAGGED)?.concurrentTurns === true;
  // As a registry install or an older caller does.
  await runCauseEffect(store.save({ ...saveBase, id: FLAGGED, command: binFlagged, usagePrompt: null }));
  const keptOverFlaglessSave = store.configs().find((agent) => agent.id === FLAGGED)?.concurrentTurns === true;
  report.store = {
    savedWithFlag,
    keptOverFlaglessSave,
    plain: store.configs().find((agent) => agent.id === PLAIN)?.concurrentTurns === true,
  };
  assert.equal(savedWithFlag, true);
  assert.equal(keptOverFlaglessSave, true, "A save without the field reset the flag.");
  assert.equal(report.store.plain, false, "The plain fake gained a flag.");

  // 3. The driver: two sessions of the flagged agent's one process turn at the same time.
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
  const slowThread = await startThread(client, { model, cwd: workspace });
  const fastThread = await startThread(client, { model, cwd: workspace });
  assert.notEqual(slowThread, fastThread);

  let slowEnded = 0;
  let fastEnded = 0;
  const slowTurn = runTurn(client, slowThread, { model, text: "list slow facts" }).then((turn) => {
    slowEnded = Date.now();
    return turn;
  });
  // The fake logs the prompt when it starts it; the fast turn starts only once the slow one holds
  // its session, so a serialized fake would make it wait. Wait on the log, not elapsed time.
  const deadline = Date.now() + 30_000;
  for (;;) {
    const entries = await readJsonl<LogEntry>(log);
    if (entries.some((entry) => entry.event === "prompt" && entry.slow === true)) break;
    assert.ok(Date.now() < deadline, "The slow prompt never reached the fake.");
    await new Promise((finish) => setTimeout(finish, 100));
  }
  const fastTurn = runTurn(client, fastThread, { model, text: "say it fast" }).then((turn) => {
    fastEnded = Date.now();
    return turn;
  });
  const [slow, fast] = await Promise.all([slowTurn, fastTurn]);
  assert.equal(slow.error, null, slowReplyError(slow.reply));
  assert.equal(fast.error, null, fast.reply.slice(0, 200));
  assert.match(slow.reply, /slow done/);
  assert.match(fast.reply, /fast done/);
  const fastBeatSlow = fastEnded > 0 && fastEnded < slowEnded;
  report.turns = { fastBeatSlow, slowReply: slow.reply, fastReply: fast.reply };
  assert.ok(fastBeatSlow, "The fast turn outlasted the slow one: the sessions were serialized.");

  report.passed = true;
} finally {
  await stopClients(clients);
  await rm(root, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function slowReplyError(reply: string): string {
  return `The slow turn failed: ${reply.slice(0, 200)}`;
}
