// The custom ACP agent of `acp-context-overflow-e2e.ts`. The first prompt of the first session
// fails as an overfull provider gateway does. The next prompt, which OpenBot sends in a replacement
// session, answers. `FAKE_FAILURE=other` makes `session/prompt` fail with a non-overflow error. The
// one-failure state is a file because OpenBot may replace the whole agent process with the session.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { logEntry, serveFakeAcpAgent } from "../acp-agent";

const mode = process.env.FAKE_FAILURE ?? "overflow";
const agentId = process.env.FAKE_AGENT_ID ?? "unknown";
const statePath = process.env.FAKE_STATE;
let sessions = 0;

/** Whether this agent has not failed yet across processes; the first caller records and answers true. */
function firstFailure(): boolean {
  if (!statePath) return true;
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const failed: readonly string[] = Array.isArray(state.failed) ? state.failed : [];
    return !failed.includes(agentId);
  } catch {}
  return true;
}

function recordFailure(): void {
  if (!statePath) return;
  const failed: string[] = [];
  try {
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      const stored: readonly unknown[] = Array.isArray(state.failed) ? state.failed : [];
      failed.push(...stored.filter((value): value is string => typeof value === "string"));
    }
  } catch {}
  writeFileSync(statePath, `${JSON.stringify({ failed: [...new Set([agentId, ...failed])] })}\n`);
}

function promptText(params: { prompt?: { type: string; text?: string }[] }): string {
  return (params.prompt ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join(" ");
}

serveFakeAcpAgent(
  {
    initialize: (request, peer) =>
      peer.reply(request, {
        protocolVersion: 1,
        authMethods: [],
        agentInfo: { name: "context-overflow", title: "Context Overflow", version: "1.0.0" },
        agentCapabilities: { loadSession: true },
      }),
    "session/new": (request, peer) => {
      sessions += 1;
      const sessionId = `${agentId}-${process.pid}-${sessions}`;
      logEntry({ event: "request", pid: process.pid, agentId, method: "session/new", sessionId });
      peer.reply(request, {
        sessionId,
        models: { availableModels: [{ modelId: "default", name: "Default" }], currentModelId: "default" },
      });
    },
    "session/load": (request, peer) => peer.reply(request, {}),
    "session/prompt": (request, peer) => {
      const sessionId = request.params.sessionId ?? "";
      const text = promptText(request.params);
      logEntry({
        event: "prompt",
        pid: process.pid,
        agentId,
        sessionId,
        hasTrigger: text.includes("cause failure"),
        textLength: text.length,
      });
      if (firstFailure()) {
        recordFailure();
        const message =
          mode === "overflow"
            ? 'HTTP 400: {"error":"Context limit exceeded"}'
            : "HTTP 401: unauthorized provider token";
        logEntry({ event: "failed", pid: process.pid, agentId, sessionId, overflow: mode === "overflow" });
        peer.fail(request, { code: -32603, message });
        return;
      }
      peer.say(sessionId, "Recovered.");
      peer.reply(request, { stopReason: "end_turn" });
    },
  },
  {
    onRequest: (request) => {
      if (request.method === "session/prompt" || request.method === "session/new") return;
      logEntry({
        event: "request",
        pid: process.pid,
        agentId,
        method: request.method,
        sessionId: request.params.sessionId ?? null,
      });
    },
  },
);
