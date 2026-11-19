import type { AgentProviderId, AgentProviderRef } from "./agent-providers";
import {
  agentProviderDescriptor,
  customAgentIdOfModel,
  isCustomAgentId,
  isKnownAgentProvider,
  isNewCustomAgentId,
} from "./agent-providers";
import { INPUT_LIMITS } from "./input-limits";
import { isBoundedString, isNullableBoundedString } from "./ipc-bounded-values";
import { CUSTOM_PROVIDER_RESTARTS, type CustomProviderRestart } from "./ipc-custom-providers";
import { isBoolean, isDynamicRecord, isOneOf, isString } from "./runtime-values";

export const CUSTOM_AGENT_LIMITS = {
  agents: 16,
  command: 1_024,
  args: 32,
  arg: 1_024,
  env: 16,
  envValue: 4_096,
  capabilities: 32,
  checkModels: 256,
  usagePrompt: 256,
  usageAnswer: 4_000,
} as const;

export const CUSTOM_AGENT_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface CustomAgentEnvInput {
  name: string;
  value: string | null;
}

export interface SaveCustomAgentInput {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: CustomAgentEnvInput[];
  usagePrompt: string | null;
  /**
   * Whether the command runs turns of two sessions of one working folder at the same time, as the
   * user sets it in the agent's dialog (a check seeds the dialog's choice from what the agent's
   * `initialize` answer advertised). Absent keeps the saved flag, so a registry install or a sender
   * that does not know the field does not reset it.
   */
  concurrentTurns?: boolean;
  /**
   * Whether the command takes a message into its running turn, answering the `_session/steering`
   * extension request, as the user sets it in the agent's dialog (a check seeds the dialog's choice
   * from what the agent's `initialize` answer advertised). Absent keeps the saved flag, as for
   * `concurrentTurns`.
   */
  steer?: boolean;
}

export interface DeleteCustomAgentInput {
  id: string;
}

export interface CustomAgentSummary {
  id: string;
  name: string;
  command: string;
  args: string[];
  envNames: string[];
  usagePrompt?: string | null | undefined;
  concurrentTurns?: boolean | undefined;
  steer?: boolean | undefined;
  resolvedCommand: string | null;
}

export interface CustomAgentUsage {
  id: string;
  text: string;
}

export interface CustomAgentResult {
  agents: CustomAgentSummary[];
  restart: CustomProviderRestart;
}

export interface CheckCustomAgentInput {
  command: string;
  args: string[];
  env: CustomAgentEnvInput[];
  savedAgentId?: string;
}

export interface CustomAgentCheckResult {
  agentName: string;
  version: string | null;
  protocolVersion: number;
  capabilities: string[];
  models: string[];
  /** `true` when the agent's `initialize` answer had `"_meta": { "concurrentTurns": true }`. */
  concurrentTurns: boolean;
  /** `true` when the agent's `initialize` answer had `"_meta": { "steering": { "supported": true } }`. */
  steer: boolean;
}

export interface DetectedAcpAgent {
  id: string;
  name: string;
  command: string;
  args: string[];
}

function isArgs(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= CUSTOM_AGENT_LIMITS.args &&
    value.every((arg) => isBoundedString(arg, CUSTOM_AGENT_LIMITS.arg))
  );
}

export function isCustomAgentUsagePrompt(value: unknown): value is string {
  return isBoundedString(value, CUSTOM_AGENT_LIMITS.usagePrompt) && value.trim().length > 0 && !/[\0\r\n]/.test(value);
}

export function isCustomAgentEnvName(value: unknown): value is string {
  return isBoundedString(value, INPUT_LIMITS.identifier) && CUSTOM_AGENT_ENV_NAME_PATTERN.test(value);
}

export function isCustomAgentSummary(value: unknown): value is CustomAgentSummary {
  return (
    isDynamicRecord(value) &&
    !("env" in value) &&
    !("secret" in value) &&
    !("value" in value) &&
    isString(value.id) &&
    isCustomAgentId(value.id) &&
    isBoundedString(value.name, INPUT_LIMITS.agentName) &&
    isBoundedString(value.command, CUSTOM_AGENT_LIMITS.command) &&
    isArgs(value.args) &&
    Array.isArray(value.envNames) &&
    value.envNames.length <= CUSTOM_AGENT_LIMITS.env &&
    value.envNames.every(isCustomAgentEnvName) &&
    (value.usagePrompt === undefined || value.usagePrompt === null || isCustomAgentUsagePrompt(value.usagePrompt)) &&
    (value.concurrentTurns === undefined || isBoolean(value.concurrentTurns)) &&
    (value.steer === undefined || isBoolean(value.steer)) &&
    isNullableBoundedString(value.resolvedCommand, CUSTOM_AGENT_LIMITS.command)
  );
}

export function isCustomAgentResult(value: unknown): value is CustomAgentResult {
  return (
    isDynamicRecord(value) &&
    Array.isArray(value.agents) &&
    value.agents.length <= CUSTOM_AGENT_LIMITS.agents &&
    value.agents.every(isCustomAgentSummary) &&
    isOneOf(CUSTOM_PROVIDER_RESTARTS, value.restart)
  );
}

export function isCustomAgentUsage(value: unknown): value is CustomAgentUsage {
  return (
    isDynamicRecord(value) &&
    isString(value.id) &&
    isCustomAgentId(value.id) &&
    isBoundedString(value.text, CUSTOM_AGENT_LIMITS.usageAnswer)
  );
}

export function isCustomAgentCheckResult(value: unknown): value is CustomAgentCheckResult {
  return (
    isDynamicRecord(value) &&
    isBoundedString(value.agentName, INPUT_LIMITS.agentName) &&
    isNullableBoundedString(value.version, 160) &&
    typeof value.protocolVersion === "number" &&
    Number.isInteger(value.protocolVersion) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.length <= CUSTOM_AGENT_LIMITS.capabilities &&
    value.capabilities.every((name) => isBoundedString(name, INPUT_LIMITS.identifier)) &&
    Array.isArray(value.models) &&
    value.models.length <= CUSTOM_AGENT_LIMITS.checkModels &&
    value.models.every((name) => isBoundedString(name, INPUT_LIMITS.modelName)) &&
    isBoolean(value.concurrentTurns) &&
    isBoolean(value.steer)
  );
}

/**
 * Whether two sessions of one agent can run a turn at the same time. Every provider answers with
 * its descriptor; only `acp` can differ from it: a custom agent with a saved `concurrentTurns`
 * choice — the user sets it in the dialog, and a check seeds it from the agent's advertised
 * `"_meta": { "concurrentTurns": true }` — runs parallel lanes up to the agent's task limit, and any
 * other custom agent stays at one turn at a time. `customAgents` is the saved list
 * (`CustomAgentSummary` in the renderer, `CustomAgentConfig` in the backend).
 */
export function agentConcurrentTurns(
  agent: { provider: AgentProviderId; model: string },
  customAgents: readonly { id: string; concurrentTurns?: boolean | undefined }[],
): boolean {
  if (agent.provider === "acp") {
    const id = customAgentIdOfModel(agent.model);
    return (id !== null && customAgents.find((custom) => custom.id === id)?.concurrentTurns) === true;
  }
  return agentProviderDescriptor(agent.provider).concurrentTurns;
}

/**
 * Whether the agent takes a queued message into its running turn. A provider that this build does
 * not know can: its host decides, and refuses the message when it cannot. Every known provider
 * answers with its descriptor; only `acp` can differ from it: a custom agent with a saved `steer`
 * choice — the user sets it in the dialog, and a check seeds it from the agent's advertised
 * `"_meta": { "steering": { "supported": true } }` — answers the `_session/steering` extension
 * request, and any other custom agent keeps its messages queued until the turn ends.
 * `customAgents` is the saved list, as for `agentConcurrentTurns`.
 */
export function agentSteers(
  agent: { provider: AgentProviderRef; model: string },
  customAgents: readonly { id: string; steer?: boolean | undefined }[],
): boolean {
  if (!isKnownAgentProvider(agent.provider)) return true;
  if (agent.provider === "acp") {
    const id = customAgentIdOfModel(agent.model);
    return (id !== null && customAgents.find((custom) => custom.id === id)?.steer) === true;
  }
  return agentProviderDescriptor(agent.provider).steer === "native";
}

export function isDetectedAcpAgent(value: unknown): value is DetectedAcpAgent {
  return (
    isDynamicRecord(value) &&
    !("env" in value) &&
    isString(value.id) &&
    isNewCustomAgentId(value.id) &&
    isBoundedString(value.name, INPUT_LIMITS.agentName) &&
    isBoundedString(value.command, CUSTOM_AGENT_LIMITS.command) &&
    isArgs(value.args)
  );
}
