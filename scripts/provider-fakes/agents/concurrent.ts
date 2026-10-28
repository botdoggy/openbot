// The ACP agent of `acp-concurrent-turns-e2e.ts`. `FAKE_CONCURRENT=1` makes it advertise
// `"_meta": { "concurrentTurns": true }` in its `initialize` answer — the opt-in of custom agents
// that run the turns of two sessions of one process at the same time. A prompt that mentions
// "slow" answers after FAKE_SLOW_MS; every other prompt answers at once, so a driver that takes two
// sessions in one process can show the fast turn ending before the slow one.
import { type AcpParams, type AcpPeer, type AcpRequest, logEntry, serveFakeAcpAgent } from "../acp-agent";

const slowMs = Number(process.env.FAKE_SLOW_MS ?? 2_500);
let count = 0;

function promptText(params: AcpParams): string {
  return (params.prompt ?? []).map((block) => block.text ?? "").join(" ");
}

serveFakeAcpAgent({
  initialize: (request, peer) =>
    peer.reply(request, {
      protocolVersion: 1,
      agentInfo: { name: "concurrent-fake", version: "1.0.0" },
      agentCapabilities: {},
      authMethods: [],
      ...(process.env.FAKE_CONCURRENT === "1" ? { _meta: { concurrentTurns: true } } : {}),
    }),
  "session/new": (request, peer) => {
    count += 1;
    peer.reply(request, { sessionId: `s-${count}` });
  },
  "session/prompt": (request: AcpRequest, peer: AcpPeer) => {
    const sessionId = request.params.sessionId ?? "";
    const slow = promptText(request.params).includes("slow");
    logEntry({ event: "prompt", sessionId, slow });
    const answer = () => {
      // The handler returns before the timer, so the read loop takes the next prompt at once.
      peer.say(sessionId, slow ? "slow done" : "fast done");
      peer.reply(request, { stopReason: "end_turn" });
    };
    if (slow) setTimeout(answer, slowMs);
    else answer();
  },
});
