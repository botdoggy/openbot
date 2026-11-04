### Added

- A custom ACP agent can opt into concurrent turns: a busy agent starts a new turn instead of
  queueing. The opt-in is one user-owned flag per agent, seeded by the capability check, editable
  in the custom-agent dialog and settings.
- A custom ACP agent can accept a steer of its running turn, via the `_session/steering` wire
  protocol, when the startup check reports the capability.
- ACP agents stream their context-compaction updates into the chat, so a compaction in progress
  no longer looks like a dead turn.

### Fixed

- A custom ACP agent that reports context overflow ends the wedged session and starts a new one
  for the next turn, instead of stalling every later turn.
