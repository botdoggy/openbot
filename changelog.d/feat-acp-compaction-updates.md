### Added

- OpenBot now asks ACP agents for their compaction updates with the ACP `session.compaction`
  client capability. An agent that reports its compaction no longer leaves the turn looking stalled;
  OpenBot receives the update it already handles for context state and instructions.
