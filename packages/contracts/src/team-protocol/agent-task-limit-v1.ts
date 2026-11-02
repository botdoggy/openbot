// Frozen optional agent-task-limit-v1 wire contract.
//
// What it grants, recorded here because freezing it makes it permanent: an owner or admin of a
// server can read and change how many tasks of each agent run a turn at the same time on that host
// (`taskLimit`, 1 to 10 in this fork, 1 to 4 upstream). Null means the host default. A provider
// that runs one turn at a time still runs one task, whatever the value. A lower limit stops no
// running task; the next turn waits. A member cannot use either route; `requireAdmin` on the host
// is the only gate. Bounds and meaning do not follow IPC changes; widening any of it needs a
// second capability string.
//
// Fork divergence: upstream froze the bound at 4; this fork widens it in place to follow
// AGENT_TASK_LIMIT_MAX (10). Older clients and servers only ever send 1 to 4, which stays valid,
// so both directions keep working; a stock upstream host still refuses a value above 4 from a
// fork client.
import { type AdminDecoder, adminRoute, fields, identifier, nullable, type OptionalRouteCodec } from "./admin-wire";

export const AGENT_TASK_LIMIT_CAPABILITY = "agent-task-limit-v1";

export const AGENT_TASK_LIMIT_ROUTES = {
  settings: "/v1/admin/agents/task-limit",
  update: "/v1/admin/agents/task-limit/update",
} as const;

const limit: AdminDecoder = (input) => {
  // The fork bound: follows AGENT_TASK_LIMIT_MAX (10), not the frozen upstream 4.
  if (typeof input !== "number" || !Number.isInteger(input) || input < 1 || input > 10)
    throw new Error("Invalid agent task limit.");
  return input;
};
const taskLimit = nullable(limit);
const settings = fields({ taskLimit });

export const AGENT_TASK_LIMIT_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [AGENT_TASK_LIMIT_ROUTES.settings, adminRoute(fields({ agentId: identifier }), settings)],
  [AGENT_TASK_LIMIT_ROUTES.update, adminRoute(fields({ agentId: identifier, taskLimit }), settings)],
]);
