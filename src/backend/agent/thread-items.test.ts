// @vitest-environment node

import { describe, expect, it } from "vitest";
import { refusedSessionFailure } from "./thread-items";

describe("refusedSessionFailure", () => {
  it("recognizes a custom ACP context overflow, as mu's upstream gateway words it", () => {
    expect(refusedSessionFailure("acp", 'HTTP 400: {"error":"Context limit exceeded"}')).not.toBeNull();
  });

  it.each([
    "This model's maximum context length is 200000 tokens.",
    "context_length_exceeded: too many tokens",
    "The request exceeds the context window of the model.",
    "The prompt is too long for this model.",
    "Please reduce the length of the messages.",
  ])("recognizes the common overflow phrasing %s for ACP", (message) => {
    expect(refusedSessionFailure("acp", message)).not.toBeNull();
  });

  it("ignores other custom ACP failures", () => {
    expect(refusedSessionFailure("acp", "HTTP 400: invalid tool schema")).toBeNull();
    expect(refusedSessionFailure("acp", "HTTP 401: unauthorized")).toBeNull();
  });

  it("does not turn overflow wording of other providers into a refusal", () => {
    expect(refusedSessionFailure("claude", 'HTTP 400: {"error":"Context limit exceeded"}')).toBeNull();
    // OpenCode answers with its own generic refusal instead (#2351).
    expect(refusedSessionFailure("opencode", "context_length_exceeded: too many tokens")).toBeNull();
    expect(refusedSessionFailure("muse", "The prompt is too long for this model.")).toBeNull();
  });
});
