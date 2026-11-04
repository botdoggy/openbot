### Added

- A custom ACP agent can opt into steering a running turn with a per-agent setting. When the user
  turns it on, a message sent in `steer` mode joins the agent's running turn over the private ACP
  steering request; every other custom ACP agent keeps such a waiting message queued.
