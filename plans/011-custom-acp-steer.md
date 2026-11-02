# Plan 011: Custom ACP agents steer a running turn

> **State**: DONE. Implemented on `custom-acp-steer` (uncommitted); verification below all passed.
> **Planned at**: branch `custom-acp-steer`, after `eeb1b302f` (v0.58.0-bd.2).

## Request

Custom ACP agents cannot steer: a message sent in "steer" mode always waits in the queue with the
"provider-unsupported" fallback, while Claude, Codex, Grok, Pi, Muse and Inception steer into the
running turn. ACP itself has no steer request (`@agentclientprotocol/sdk` defines only
`session/new|load|fork|resume|close|set_mode|set_model|prompt|cancel`), so the capability must be an
opt-in extension, seeded like `_meta.concurrentTurns` (commit `35af2cd17`).

## What exists today

| Piece | Where | Role |
|---|---|---|
| `steer: "native" \| "deferred"` descriptor | `packages/contracts/src/agent-providers.ts:158` | `acp`, opencode, antigravity, cursor, cline are `"deferred"` |
| Preference gate | `AgentService.steerWhenBusy` (`agent-service.ts:4784`) | `busyMessageMode ?? DEFAULT_BUSY_MESSAGE_MODE` (`"queue"`) must be `"steer"` |
| Capability gate (send) | `agent-service.ts:4787` | descriptor-only; marks `provider-unsupported` fallback |
| Capability gate (queued steer) | `QueueControls.steer` (`queue-controls.ts:252`) | same descriptor-only check |
| Client steer hook | `AcpProviderOptions.steer` (`acp-client.ts:428`), used at `acp-client.ts:1087` | only Grok sets it, `_x.ai/interject` (`grok-client.ts:81`) |
| Custom child factory | `customAgentChild` (`provider-drivers.ts:1055`) | passes `customAgentFlavor`, never a `steer` option |
| Opt-in seed precedent | `concurrentTurnsAdvertised` (`acp-agent-check.ts:182`), dialog switch (`CustomAcpAgentDialog.tsx`), `agentConcurrentTurns` (`packages/contracts/src/ipc-agent-tasks.ts`) | the pattern to copy |

## Design

OpenBot defines the extension: an agent opts in with `"_meta": { "steer": true }` in its
`initialize` answer and implements the request `_openbot/steer` with
`{ sessionId, messageId: string | null, content: ContentBlock[] }`. Resolving it means the message
was taken into the running turn; a JSON-RPC error or timeout means refused, and the caller's
existing fallback restores the message to the queue.

## Changes

1. **`packages/contracts/src/ipc-custom-agents.ts`** — `CustomAgentConfig.steer?: boolean` and the
   dialog/check-result field, mirroring `concurrentTurns`. A save without the field (registry
   install) keeps the saved choice.
2. **`packages/contracts/src/ipc-agent-tasks.ts`** (or a new ipc module) — `agentSteers(agent,
   customAgents)`: true when the provider descriptor is `"native"`, or the agent is a custom ACP
   agent whose saved config carries `steer: true`. Sits next to `agentConcurrentTurns`.
3. **`src/backend/acp-agent-check.ts`** — `steerAdvertised(initialization)`:
   `initialization._meta?.steer === true`; added to `checkResult`.
4. **Renderer** — `CustomAcpAgentDialog.tsx` gets a "Steers a running turn" switch seeded by a
   successful check until the user touches it (the `concurrentTurns` switch is the template);
   `custom-acp-agent-form.ts`, `detected-providers.ts`, en strings in
   `packages/i18n/src/messages/en/customProvider.ts`.
5. **`src/backend/custom-acp-agents-client.ts`** — read the flag through in the config type
   (`:62` area).
6. **`src/backend/provider-drivers.ts` `customAgentChild`** — when the saved config has
   `steer: true`, pass `steer` in `AcpProviderOptions`: send `_openbot/steer` via
   `connection.extMethod` with the session id, message id and blocks. Grok keeps its own
   `_x.ai/interject` hook.
7. **`src/backend/agent-service.ts:4787`** and **`src/backend/agent/queue-controls.ts:252`** —
   replace `agentProviderDescriptor(...).steer !== "native"` with `!agentSteers(agent,
   customAgents)`. Both need the custom-agents source; `agent-service.ts` already resolves custom
   agents for `agentTaskLimit` (see `35af2cd17`), and `QueueControls` gets the same hook.
8. **Mailbox/UI fallback text** — unchanged: refusals already restore the message to the queue via
   `restoreUnsteered` (`queue-controls.ts`) / wait with the `provider-unsupported` label
   (`agent-service.ts`).

No change to the busy-message settings semantics: the per-agent `busyMessageMode` stays the
preference gate and `"queue"` stays the global default; capability only decides whether `"steer"`
is honored.

## Behavior after the change

| busyMessageMode | Agent advertises `_meta.steer` | Result |
|---|---|---|
| queue / unset | irrelevant | message waits in queue (unchanged) |
| steer | no | waits in queue, `provider-unsupported` label (unchanged) |
| steer | yes | `_openbot/steer` into the running turn; on error/timeout or an ended turn the message goes back to the queue and starts as the next turn |

## Verification

1. **New e2e: `scripts/acp-steer-e2e.ts`** (`test:acp:steer`), modeled on
   `acp-concurrent-turns-e2e.ts` and driven through the real modules, no Electron, no network:
   - New fake `scripts/provider-fakes/agents/custom-steer.ts`, modeled on `grok-steer.ts`: a `work`
     prompt holds its turn open until `_openbot/steer` arrives, then answers with the steered text;
     `_meta.steer: true` is advertised only when `FAKE_STEER=1`.
   - Check: `checkAcpAgent` reads the flag on the flagged fake and not on the plain one.
   - Store: the flag survives a later save that does not name it; the plain agent stays absent.
   - Driver: queue a message while `work` runs, steer it — the fake's log shows `_openbot/steer`
     answered before the turn ends, and the turn's answer carries the steered text.
   - Plain agent: the steer is refused at the gate, the message waits, and after the turn ends it is
     delivered as the next turn's prompt.
2. **Regression run**: `test:acp:concurrent-turns`, `test:acp-flavors`, `grok-steer-e2e.ts`,
   `pi-steer-e2e.ts` — the gates moved, so every existing steer/parallel path must behave as before.
3. **Static**: `bun run typecheck`, `bun run lint` (biome), `bun run test` for touched packages.
4. **Manual smoke** (optional, before merge): a real custom agent entry pointed at the fake, send
   `work`, send a second message with the agent's busy mode on steer, watch the queue row.

## Follow-up: the steer affordances (DONE)

The dock snapshot and the main composer gated the affordance on `providerSteersTurns(agent.provider)`,
a provider-static predicate that could not see the saved flag. Done on this branch:

- `BrowserDockAdapter.tsx`: both the overlay snapshot's `steerSupported` and the surface queue's
  `onSteer` resolve via `agentSteers({provider, model}, props.customAgents ?? [])`.
- `ConversationComposer.tsx`: `steers()` (Tab-to-steer and the queue row action) resolves the same,
  with `props.customAgents` from the conversation view scope; a joined server keeps the descriptor's
  answer, correct because the flag is the local user's own.
- `agentSteers` gained `AgentProviderRef` semantics: an unknown (foreign) provider answers true, as
  `providerSteersTurns` did; `providerSteersTurns` is removed, having no callers left.
- `WebWorkspace.tsx` and `WorkspaceChannelConversation.tsx` only pass the handler; the gating was
  all in the two components above, so no change needed there.

Verified: typechecks (contracts, node, renderer, storybook), biome clean on touched files, vitest
1123/1123, `test:acp:steer` still passes. `knip:check` OOMs identically on clean main (environment).

The dock snapshot hides the steer button via `providerSteersTurns(agent.provider)`
(`BrowserDockAdapter.tsx:290`), a provider-static predicate that cannot see the saved flag. All
inputs are already on the adapter: `props.agent` is the full `AgentProfile` (`provider` + `model`,
`conversation-types.ts:193`) and `ConversationProps.customAgents` is populated by
`WorkspaceConversation.tsx:511` for the local server. The change is one line + one import:

- `BrowserDockAdapter.tsx`: `steerSupported: agentSteers({ provider: agent.provider, model: agent.model }, props.customAgents ?? [])`.
- Check the other dock surfaces (`WebWorkspace.tsx`, channel view) take the same path or stay
  descriptor-based for a joined server, where `customAgents` is absent — the flag is the local
  user's own, so a remote `acp` agent correctly keeps the descriptor's answer.
- Verification: storybook/preview builds typecheck; add the flagged case to the browser-dock
  decoding fixtures if a fixture builds the presentation; manual smoke optional.

The mobile settings hint (`AgentBusyMessageField`, descriptor-only) is **out of scope**: mobile
never reads the local custom-agent store, so a correct hint would need the flags carried over the
host team protocol.

## STOP conditions

- The change would let an unflagged agent steer (the gate must stay deny-by-default).
- A steer refusal drops the message instead of restoring it to the queue.
- Grok, Pi, Claude, Codex, Muse or Inception steering changes behavior.
