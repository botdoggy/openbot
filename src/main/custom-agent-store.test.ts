// @vitest-environment node

// The saved flag that decides whether a custom ACP agent runs one turn at a time: it comes from
// the agent's check (`initialize` `_meta`), rides the plain `custom-agents.json` envelope like
// `usagePrompt` did, and a save from a sender that does not know it must not reset it.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentConcurrentTurns } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { CustomAgentStore } from "./custom-agent-store";

const cipher = {
  canPersist: () => true,
  encrypt: (value: string) => Buffer.from(value),
  decrypt: (value: Buffer) => value.toString(),
};

async function withStore<T>(run: (store: CustomAgentStore, path: string) => Promise<T>): Promise<T> {
  const folder = await mkdtemp(join(tmpdir(), "openbot-custom-agent-store-test-"));
  try {
    const path = join(folder, "custom-agents.json");
    const store = new CustomAgentStore({ path, cipher, resolve: () => Effect.succeed("mu") });
    await Effect.runPromise(store.load());
    return await run(store, path);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

describe("custom agent store: concurrentTurns", () => {
  it("saves the flag, keeps it over a reload, and hands it to spawns and summaries", async () => {
    await withStore(async (store, path) => {
      await Effect.runPromise(
        store.save({
          id: "mymu",
          name: "mu",
          command: "mu",
          args: ["--mode", "acp"],
          env: [],
          usagePrompt: null,
          concurrentTurns: true,
        }),
      );
      const written = JSON.parse(await readFile(path, "utf8"));
      expect(written.agents[0].concurrentTurns).toBe(true);

      const reloaded = new CustomAgentStore({ path, cipher, resolve: () => Effect.succeed("mu") });
      await Effect.runPromise(reloaded.load());
      expect(reloaded.configs()[0]?.concurrentTurns).toBe(true);
      const summaries = await Effect.runPromise(reloaded.list());
      expect(summaries[0]?.concurrentTurns).toBe(true);
    });
  });

  it("keeps the flag when a save does not name it, and defaults to false", async () => {
    await withStore(async (store) => {
      await Effect.runPromise(
        store.save({
          id: "mymu",
          name: "mu",
          command: "mu",
          args: [],
          env: [],
          usagePrompt: null,
          concurrentTurns: true,
        }),
      );
      // A registry install or an older caller sends no flag: the saved one stays.
      await Effect.runPromise(
        store.save({ id: "mymu", name: "mu", command: "mu", args: [], env: [], usagePrompt: null }),
      );
      expect(store.configs()[0]?.concurrentTurns).toBe(true);

      await Effect.runPromise(
        store.save({ id: "other", name: "other", command: "other", args: [], env: [], usagePrompt: null }),
      );
      expect(store.configs().find((config) => config.id === "other")?.concurrentTurns).toBe(false);
    });
  });
});

describe("agentConcurrentTurns", () => {
  const saved = [{ id: "mymu", concurrentTurns: true }, { id: "strict", concurrentTurns: false }, { id: "quiet" }];

  it("asks the provider for built-ins and the saved flag for custom ACP agents", () => {
    expect(agentConcurrentTurns({ provider: "codex", model: "gpt-6-luna" }, [])).toBe(true);
    expect(agentConcurrentTurns({ provider: "claude", model: "anthropic/claude-sonnet-5.5" }, [])).toBe(true);

    // A custom ACP agent without the flag runs one turn at a time, as before this change.
    expect(agentConcurrentTurns({ provider: "acp", model: "strict/default" }, saved)).toBe(false);
    expect(agentConcurrentTurns({ provider: "acp", model: "quiet/default" }, saved)).toBe(false);
    expect(agentConcurrentTurns({ provider: "acp", model: "gone/default" }, saved)).toBe(false);
    expect(agentConcurrentTurns({ provider: "acp", model: "" }, saved)).toBe(false);

    // The agent that advertised `_meta.concurrentTurns` at its check runs parallel lanes.
    expect(agentConcurrentTurns({ provider: "acp", model: "mymu/default" }, saved)).toBe(true);
  });
});
