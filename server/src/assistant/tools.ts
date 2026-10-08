import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  ASSISTANT_MAX_WORKSPACES,
  type AssistantNotificationInput,
  type AssistantSource,
} from "../../../shared/assistant";

export const ASSISTANT_DEFAULT_TERMINAL_LINES = 120;
export const ASSISTANT_MAX_TERMINAL_LINES = 1000;

export type WorkspaceToolKind = (typeof workspaceTools)[number]["kind"];
export type WorkspaceToolResult = {
  text: string;
  sources?: AssistantSource[];
};
export type WorkspaceToolReader = (
  kind: WorkspaceToolKind,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<WorkspaceToolResult>;
export type ActionToolKind = (typeof actionTools)[number]["kind"];
export type ActionToolProposer = (
  kind: ActionToolKind,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<WorkspaceToolResult>;
export type TaskToolKind = "list" | "create";
export type TaskToolHandler = (
  kind: TaskToolKind,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<WorkspaceToolResult>;
export type NotificationToolSender = (
  input: AssistantNotificationInput,
  signal?: AbortSignal,
) => Promise<WorkspaceToolResult>;

export const workspaceTools = (
  ["status", "history", "diff", "terminal"] as const
).map((kind) => ({
  name: `workspace_${kind}` as const,
  kind,
  label: `Read workspace ${kind}`,
  description:
    kind === "status"
      ? "List authorized workspaces, panes, agents and task status. Omit identifiers to list the authorized scope."
      : kind === "terminal"
        ? `Read recent terminal output from an authorized workspace. Use identifiers from workspace_status. Choose lines from 1 to ${ASSISTANT_MAX_TERMINAL_LINES} (default ${ASSISTANT_DEFAULT_TERMINAL_LINES}); request more when earlier context is needed. Available output depends on Herdr support and agent state; application-owned history may remain unavailable. Results retain at most 32,000 newest characters and indicate truncation.`
        : kind === "diff"
          ? "Read working-tree changes from an authorized workspace. Use identifiers from workspace_status. Omit path to list changed files, then pass an entry's path and kind to read its diff. Supported kinds are staged, unstaged, untracked and conflicted; omitting kind reads unstaged changes."
          : `Read ${kind} from an authorized workspace. Use identifiers from workspace_status.`,
  parameters: Type.Object(
    {
      connection_id: Type.Optional(Type.String()),
      workspace_id: Type.Optional(Type.String()),
      ...(kind === "history" || kind === "terminal"
        ? { pane_id: Type.String() }
        : {}),
      ...(kind === "diff"
        ? {
            path: Type.Optional(Type.String()),
            kind: Type.Optional(
              Type.Union([
                Type.Literal("staged"),
                Type.Literal("unstaged"),
                Type.Literal("untracked"),
                Type.Literal("conflicted"),
              ]),
            ),
          }
        : {}),
      ...(kind === "terminal"
        ? {
            lines: Type.Optional(
              Type.Integer({
                minimum: 1,
                maximum: ASSISTANT_MAX_TERMINAL_LINES,
                default: ASSISTANT_DEFAULT_TERMINAL_LINES,
              }),
            ),
          }
        : {}),
    },
    { additionalProperties: false },
  ),
}));

const actionTarget = {
  connection_id: Type.String(),
  workspace_id: Type.String(),
};

export const taskTools = [
  {
    name: "list_ranger_tasks",
    kind: "list",
    label: "Read Ranger tasks",
    description:
      "List scheduled Ranger tasks in this turn's authorized scope and the current time and timezone. Use the current time before interpreting relative dates.",
    parameters: Type.Object({}, { additionalProperties: false }),
  },
  {
    name: "propose_ranger_task",
    kind: "create",
    label: "Propose a scheduled task",
    description:
      "Propose a Ranger task with an exact prompt, authorized workspace scope and schedule. Selected workspace and Agent reference identities within that scope are preserved for monitoring. A once schedule uses a future UTC ISO 8601 timestamp ending in Z. A daily schedule uses HH:mm and an IANA timezone; skipped DST times do not run and repeated times run once. An interval starts the given number of minutes after confirmation. Choose notification_mode agent for monitoring and follow-up requests: Ranger can notify only on meaningful requested outcomes or needed input, with its own title and body. The default status mode sends fixed run status notifications. Returns a pending preview: the task is enabled only when the user clicks Confirm. Scheduled tasks may read and propose operations; they never automatically confirm management actions. Ask the user if their schedule or timezone is ambiguous.",
    parameters: Type.Object(
      {
        title: Type.String({ minLength: 1, maxLength: 100 }),
        prompt: Type.String({ minLength: 1, maxLength: 32_000 }),
        notification_mode: Type.Optional(
          Type.Union([Type.Literal("status"), Type.Literal("agent")]),
        ),
        scope: Type.Array(
          Type.Object(actionTarget, { additionalProperties: false }),
          { minItems: 1, maxItems: ASSISTANT_MAX_WORKSPACES },
        ),
        schedule: Type.Union([
          Type.Object(
            { type: Type.Literal("once"), at: Type.String() },
            { additionalProperties: false },
          ),
          Type.Object(
            {
              type: Type.Literal("interval"),
              minutes: Type.Integer({ minimum: 1, maximum: 525600 }),
            },
            { additionalProperties: false },
          ),
          Type.Object(
            {
              type: Type.Literal("daily"),
              time: Type.String({ pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" }),
              timezone: Type.String({ minLength: 1, maxLength: 100 }),
            },
            { additionalProperties: false },
          ),
        ]),
      },
      { additionalProperties: false },
    ),
  },
] as const;

export const notificationTools = [
  {
    name: "send_user_notification",
    label: "Notify the user",
    description:
      "Request a notification for a meaningful outcome or needed user input covered by this confirmed task. Use completed for verified success and attention for failure or required user input. event_key must identify the same Agent session and observed outcome across runs; reuse the exact key for an unchanged event and consult prior notification receipts. Use a concise title and body grounded in fresh workspace evidence, without credentials or authorization URLs. The server chooses the recipient and task link. A receipt records acceptance or deduplication, never proof of device delivery. Stay quiet while the monitored state is unchanged or non-actionable.",
    parameters: Type.Object(
      {
        event_key: Type.String({ minLength: 1, maxLength: 200 }),
        kind: Type.Union([
          Type.Literal("completed"),
          Type.Literal("attention"),
        ]),
        title: Type.String({ minLength: 1, maxLength: 200 }),
        body: Type.String({ minLength: 1, maxLength: 400 }),
      },
      { additionalProperties: false },
    ),
  },
] as const;

export const actionTools = [
  {
    name: "propose_workspace_create",
    kind: "create_workspace",
    label: "Propose workspace creation",
    description:
      "Propose creating a workspace from an authorized source workspace. Returns a pending proposal for the user to confirm; does not create it.",
    parameters: Type.Object(
      {
        ...actionTarget,
        label: Type.String(),
        cwd: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
  },
  {
    name: "propose_worktree_create",
    kind: "create_worktree",
    label: "Propose worktree creation",
    description:
      "Propose creating a Git worktree from an authorized source workspace. Returns a pending proposal for the user to confirm; does not create it.",
    parameters: Type.Object(
      {
        ...actionTarget,
        branch: Type.String(),
        label: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
  },
  {
    name: "propose_tab_create",
    kind: "create_tab",
    label: "Propose tab creation",
    description:
      "Propose creating a terminal tab in an authorized workspace. Returns a pending proposal for the user to confirm; does not create it. Read workspace_status after confirmation to discover the new pane before proposing an agent start.",
    parameters: Type.Object(actionTarget, { additionalProperties: false }),
  },
  {
    name: "propose_pane_split",
    kind: "split_pane",
    label: "Propose pane split",
    description:
      "Propose splitting an existing pane in an authorized workspace, creating a new terminal pane to its right or below it. Use pane identifiers from workspace_status. Returns a pending proposal for the user to confirm; does not split it. Read workspace_status after confirmation to discover the new pane before proposing an agent start.",
    parameters: Type.Object(
      {
        ...actionTarget,
        pane_id: Type.String(),
        direction: Type.Union([Type.Literal("right"), Type.Literal("down")]),
      },
      { additionalProperties: false },
    ),
  },
  {
    name: "propose_agent_start",
    kind: "start_agent",
    label: "Propose starting an agent",
    description:
      "Propose starting an available agent in a pane of an authorized workspace. Returns a pending proposal for the user to confirm; does not start it.",
    parameters: Type.Object(
      { ...actionTarget, pane_id: Type.String(), agent: Type.String() },
      { additionalProperties: false },
    ),
  },
  {
    name: "propose_agent_prompt",
    kind: "send_prompt",
    label: "Propose sending a prompt",
    description:
      "Propose sending a prompt to an agent pane in an authorized workspace. Returns a pending proposal for the user to confirm; does not send it.",
    parameters: Type.Object(
      { ...actionTarget, pane_id: Type.String(), prompt: Type.String() },
      { additionalProperties: false },
    ),
  },
] as const;

/** The reader must be bound to the current turn's authorized scope and leases. */
export async function callWorkspaceTool(
  name: string,
  params: unknown,
  read: WorkspaceToolReader,
  signal?: AbortSignal,
): Promise<WorkspaceToolResult> {
  const tool = workspaceTools.find((entry) => entry.name === name);
  if (!tool) throw new Error("Unknown workspace tool.");
  if (!Value.Check(tool.parameters, params))
    throw new Error("Invalid workspace tool parameters.");
  try {
    signal?.throwIfAborted();
    const result = await read(
      tool.kind,
      params as Record<string, unknown>,
      signal,
    );
    signal?.throwIfAborted();
    return result;
  } catch {
    throw new Error(
      "Context unavailable, stale, or outside the authorized scope.",
    );
  }
}

/** The service decides whether the validated operation needs confirmation. */
export async function callActionTool(
  name: string,
  params: unknown,
  propose: ActionToolProposer,
  signal?: AbortSignal,
): Promise<WorkspaceToolResult> {
  const tool = actionTools.find((entry) => entry.name === name);
  if (!tool) throw new Error("Unknown action tool.");
  if (!Value.Check(tool.parameters, params))
    throw new Error("Invalid action tool parameters.");
  try {
    signal?.throwIfAborted();
    const result = await propose(
      tool.kind,
      params as Record<string, unknown>,
      signal,
    );
    signal?.throwIfAborted();
    return result;
  } catch {
    throw new Error(
      "Action proposal unavailable, stale, or outside the authorized scope.",
    );
  }
}

/** Task admission uses the service's current approval policy. */
export async function callTaskTool(
  name: string,
  params: unknown,
  handle: TaskToolHandler,
  signal?: AbortSignal,
): Promise<WorkspaceToolResult> {
  const tool = taskTools.find((entry) => entry.name === name);
  if (!tool) throw new Error("Unknown task tool.");
  if (!Value.Check(tool.parameters, params))
    throw new Error("Invalid task tool parameters.");
  try {
    signal?.throwIfAborted();
    const result = await handle(
      tool.kind,
      params as Record<string, unknown>,
      signal,
    );
    signal?.throwIfAborted();
    return result;
  } catch {
    throw new Error(
      "Task unavailable, invalid, or outside the authorized scope.",
    );
  }
}

/** The sender is bound to the current confirmed scheduled task and its user. */
export async function callNotificationTool(
  name: string,
  params: unknown,
  send: NotificationToolSender,
  signal?: AbortSignal,
): Promise<WorkspaceToolResult> {
  const tool = notificationTools.find((entry) => entry.name === name);
  if (!tool) throw new Error("Unknown notification tool.");
  if (!Value.Check(tool.parameters, params))
    throw new Error("Invalid notification tool parameters.");
  const input = params as AssistantNotificationInput;
  if (!input.event_key.trim() || !input.title.trim() || !input.body.trim())
    throw new Error("Invalid notification tool parameters.");
  try {
    signal?.throwIfAborted();
    const result = await send(input, signal);
    signal?.throwIfAborted();
    return result;
  } catch {
    throw new Error("Notification unavailable or outside the authorized task.");
  }
}
