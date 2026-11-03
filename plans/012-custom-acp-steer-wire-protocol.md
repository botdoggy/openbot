# Plan 012: Custom ACP steer speaks the agreed `_session/steering` wire protocol

> **State**: DONE. Implemented on `acp-steering-wire-protocol` (uncommitted); verification below all passed.
> **Planned at**: branch `acp-steering-wire-protocol`, after `010236007` (v0.59.0-bd.1).

## Request

Plan 011 invented a private extension for custom-ACP steering: `_meta.steer: true` advertised at
`initialize`, answered with `_openbot/steer`. No agent outside the fork's fake implements it, and the
real target — mu (0.1.105, as `elf-acp`) — follows the agreed ACP steering wire protocol instead:
`_meta.steering.supported: true` advertised, `_session/steering {sessionId, prompt}` answered, as
does Zed's claude-code-acp on main ("Named `_session/steering` per the agreed ACP steering wire
protocol", `zed-industries/claude-code-acp` `src/acp-agent.ts`). Switch plan 011's feature to the
agreed protocol as the one dialect, before the private one ossifies.

## Wire shapes of the agreed protocol

- Advertise: `"_meta": { "steering": { "supported": true } }` in the `initialize` answer.
- Request: `_session/steering`, params `{sessionId, prompt: [content blocks]}`; only text blocks
  keep their text.
- Answer: `{outcome: "injected"}` (into the running turn), or the idle fallback
  `{outcome: "startedNewTurn"}` (the text runs as a turn of its own); both keep the message.
  `{outcome: "promptRequired", reason: "noRunningTurn"}` only when the client sends
  `_meta.steering.idleBehavior: "promptRequired"`; OpenBot does not, keeping the safe default.
- Errors, all refusals that restore the message to the queue: `-32602` (no sessionId, no text),
  `-32002` (unknown session), `-32601` (unsupported).

## Changes

- `src/backend/acp-agent-check.ts`: `steerAdvertised` reads `_meta.steering.supported === true`.
- `src/backend/provider-drivers.ts`: `customAgentSteer` sends `_session/steering` with
  `{sessionId, prompt}`; the resolved-answer-means-kept rule covers both outcomes, so the queue
  fallback is unchanged.
- `scripts/provider-fakes/agents/custom-steer.ts`: advertises and answers the agreed protocol.
- Comments and the dialog hint name the protocol, not the private request: contracts
  (`ipc-custom-agents.ts`), `agent-service.ts`, `queue-controls.ts`, `custom-acp-agents-client.ts`,
  `custom-agent-store.ts`, `ConversationComposer.tsx`, `custom-acp-agent-form.ts`, i18n
  `customProvider.acp.steerHint`. No saved-data or UI shape changes: the flag stays a boolean named
  `steer`.

## Verification

- `bun run test:acp:steer` passes (`"passed": true`): check reads the new meta, the store keeps the
  flag, the driver sends `_session/steering` (one prompt, no cancel), the unflagged agent is
  refused before anything is sent.
- `bun run typecheck:node`, `typecheck:renderer`, and `biome check` on the changed files: clean.
- `bun run test:grok-steer`: passes (the fake's shared `AcpParams` keeps Grok's `content` field).
- Real binary: `checkAcpAgent` on `/usr/local/bin/elf-acp --mode acp` answers
  `{agentName: "mu", steer: true, concurrentTurns: true}`; a direct `_session/steering` probe of an
  idle session answers `{"outcome":"startedNewTurn"}`, and with `promptRequired`, `{"outcome":
  "promptRequired","reason":"noRunningTurn"}` with nothing queued.
- Full-turn steer against the real mu needs its model credentials; the probe's plain `session/prompt`
  met `HTTP 401: No cookie auth credentials found` from mu's ollama-cloud plugin, outside OpenBot.
  Verify in the app: run Check in the custom agent's dialog (seeds "Steers a running turn" on),
  save, send a follow-up while mu works.

## Follow-ups, not in this plan

- mu/claude-code-acp also implement `_session/steering`, so this fork now steers any custom agent
  on the agreed protocol; the upstream story becomes "support the agreed ACP steering wire protocol
  for custom agents", not "support mu".
- Mobile keeps steering through the server (While working › Steer, or the queued-message Steer
  action); its descriptor-only hint text still mislabels steerable custom agents until the mobile
  client learns the flag (upstream-owned).
