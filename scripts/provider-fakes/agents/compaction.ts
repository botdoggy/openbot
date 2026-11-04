// The custom ACP agent of `acp-compaction-e2e.ts`. It sends one completed compaction update only
// when the client offered the ACP `session.compaction` capability in `initialize`.
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { logEntry, serveFakeAcpAgent } from "../acp-agent";

let offered = false;
let sessions = 0;

serveFakeAcpAgent({
  initialize: (request, peer) => {
    offered = request.params.clientCapabilities?.session?.compaction !== undefined;
    logEntry({ event: "initialize", compactionOffered: offered });
    peer.reply(request, {
      protocolVersion: 1,
      authMethods: [],
      agentInfo: { name: "compaction", title: "Compaction", version: "1.0.0" },
      agentCapabilities: {},
    });
  },
  "session/new": (request, peer) => {
    sessions += 1;
    peer.reply(request, {
      sessionId: `compact-${process.pid}-${sessions}`,
      models: { availableModels: [{ modelId: "default", name: "Default" }], currentModelId: "default" },
    });
  },
  "session/prompt": (request, peer) => {
    const sessionId = request.params.sessionId ?? "";
    if (offered) {
      const update: SessionUpdate = {
        sessionUpdate: "compaction_update",
        compactionId: "compact-1",
        status: "completed",
      };
      logEntry({ event: "compaction", sessionId });
      peer.update(sessionId, update);
    }
    peer.say(sessionId, "Done.");
    peer.reply(request, { stopReason: "end_turn" });
  },
});
