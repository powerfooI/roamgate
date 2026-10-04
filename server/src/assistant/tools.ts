import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AssistantSource } from "../../../shared/assistant";

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

/** The callback records a proposal; execution belongs to the user confirmation path. */
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
