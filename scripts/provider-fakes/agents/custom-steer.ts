// The custom ACP agent of `acp-steer-e2e.ts`. `FAKE_STEER=1` makes it advertise
// `"_meta": { "steering": { "supported": true } }` in its `initialize` answer — the opt-in of the
// agreed ACP steering wire protocol — and answer `_session/steering` with `injected`. A `work`
// prompt stays open until a
// steer arrives (the agent reads it at its next step and answers with its text) or FAKE_HOLD_MS
// passes, whichever comes first: an agent without the extension ends the open turn on its own.
// Each other prompt answers at once.
import { type AcpPeer, type AcpRequest, logEntry, serveFakeAcpAgent } from "../acp-agent";

const steerable = process.env.FAKE_STEER === "1";
const holdMs = Number(process.env.FAKE_HOLD_MS ?? 4_000);
/** The `work` prompt that waits for a steer, by session, with its fallback timer. */
const open = new Map<string, { request: AcpRequest; timer: NodeJS.Timeout }>();
let count = 0;

function finish(peer: AcpPeer, sessionId: string, text: string): void {
  const held = open.get(sessionId);
  if (!held) return;
  open.delete(sessionId);
  clearTimeout(held.timer);
  peer.say(sessionId, text);
  peer.reply(held.request, { stopReason: "end_turn" });
}

const handlers: Record<string, (request: AcpRequest, peer: AcpPeer) => void> = {
  initialize: (request, peer) =>
    peer.reply(request, {
      protocolVersion: 1,
      agentInfo: { name: "steer-fake", version: "1.0.0" },
      agentCapabilities: {},
      authMethods: [],
      ...(steerable ? { _meta: { steering: { supported: true } } } : {}),
    }),
  "session/new": (request, peer) => {
    count += 1;
    peer.reply(request, {
      sessionId: `steer-${process.pid}-${count}`,
      models: { availableModels: [{ modelId: "default", name: "Default" }], currentModelId: "default" },
    });
  },
  "session/prompt": (request, peer) => {
    const sessionId = request.params.sessionId ?? "";
    const text = (request.params.prompt ?? []).map((block) => block.text ?? "").join("");
    logEntry({ event: "prompt", sessionId, text: text.includes("work") ? "work" : "other" });
    if (text.includes("work")) {
      const timer = setTimeout(() => finish(peer, sessionId, "done without steering"), holdMs);
      open.set(sessionId, { request, timer });
      return;
    }
    peer.say(sessionId, "ok");
    peer.reply(request, { stopReason: "end_turn" });
  },
};

if (steerable) {
  handlers["_session/steering"] = (request, peer) => {
    const sessionId = request.params.sessionId ?? "";
    const text = (request.params.prompt ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n\n");
    logEntry({
      event: "steer",
      sessionId,
      text,
      content: (request.params.prompt ?? []).map((block) => block.type),
    });
    // The steer is accepted: resolve first, then answer the held turn with its text.
    peer.reply(request, { outcome: "injected" });
    finish(peer, sessionId, `steered: ${text}`);
  };
}

serveFakeAcpAgent(handlers, {
  onRequest: (request) => {
    if (request.method === "_session/steering" && !steerable)
      logEntry({ event: "unexpected-steer", sessionId: request.params.sessionId ?? null });
  },
});
