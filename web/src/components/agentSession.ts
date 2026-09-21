import type { ConnectionClient } from "../api";
import { connectionHttpPath } from "../connectionHttp";
import { downloadFileFromUrl } from "../downloadFile";
import { store } from "../store";
import type { Pane } from "../types";

export function paneHasAgentHistory<T extends Pick<Pane, "agent">>(
  pane?: T | null,
): pane is T & { agent: string } {
  return typeof pane?.agent === "string" && pane.agent.trim().length > 0;
}

export function groupAgentPanesByWorkspace<
  T extends Pick<Pane, "agent" | "workspace_id">,
>(panes: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const pane of panes) {
    if (!paneHasAgentHistory(pane)) continue;
    const workspacePanes = grouped.get(pane.workspace_id);
    if (workspacePanes) workspacePanes.push(pane);
    else grouped.set(pane.workspace_id, [pane]);
  }
  return grouped;
}

export type AgentStateKind =
  | "working"
  | "blocked"
  | "idle"
  | "done"
  | "unknown";

export function agentStateKind(status?: string): AgentStateKind {
  switch ((status ?? "unknown").toLowerCase()) {
    case "working":
      return "working";
    case "blocked":
      return "blocked";
    case "idle":
      return "idle";
    case "done":
      return "done";
    default:
      return "unknown";
  }
}

export function shouldShowAgentStatusLabel(status?: string): boolean {
  const kind = agentStateKind(status);
  return kind !== "idle" && kind !== "unknown";
}

const AGENT_STATE_PRIORITY: Record<AgentStateKind, number> = {
  blocked: 5,
  working: 4,
  idle: 3,
  done: 2,
  unknown: 1,
};

export type TabAgentSummary = {
  primaryAgent: string;
  additionalAgents: number;
  agents: string[];
  status: AgentStateKind;
};

export function summarizeTabAgents<
  T extends Pick<Pane, "agent" | "agent_status" | "focused" | "tab_id">,
>(panes: readonly T[], tabId: string): TabAgentSummary | null {
  const matching = panes.filter(
    (pane) => pane.tab_id === tabId && paneHasAgentHistory(pane),
  );
  if (matching.length === 0) return null;

  const focused = matching.find((pane) => pane.focused);
  const ordered = focused
    ? [focused, ...matching.filter((pane) => pane !== focused)]
    : matching;
  const agents: string[] = [];
  let status: AgentStateKind = "unknown";
  for (const pane of ordered) {
    const agent = pane.agent?.trim() ?? "";
    if (!agent) continue;
    if (
      !agents.some(
        (candidate) => candidate.toLowerCase() === agent.toLowerCase(),
      )
    ) {
      agents.push(agent);
    }
    if (agent.toLowerCase() !== agents[0]?.toLowerCase()) continue;
    const candidateStatus = agentStateKind(pane.agent_status);
    if (AGENT_STATE_PRIORITY[candidateStatus] > AGENT_STATE_PRIORITY[status]) {
      status = candidateStatus;
    }
  }

  return {
    primaryAgent: agents[0],
    additionalAgents: agents.length - 1,
    agents,
    status,
  };
}

type SessionTokenUsage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number | null;
};

export type AgentSessionTrajectoryStep = {
  step_id: number;
  timestamp?: string;
  source: "system" | "user" | "agent";
  message: string;
  reasoning_content?: string;
  tool_calls?: {
    tool_call_id: string;
    function_name: string;
    arguments: Record<string, unknown>;
    extra?: Record<string, unknown>;
  }[];
  observation?: {
    results: {
      source_call_id?: string;
      content?: string;
    }[];
  };
  metrics?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cached_tokens?: number;
    extra?: Record<string, unknown>;
  };
  extra?: Record<string, unknown>;
};

type AgentSessionTrajectory = {
  schema_version: string;
  session_id?: string;
  trajectory_id?: string;
  agent: { name: string; version: string; model_name?: string };
  steps: AgentSessionTrajectoryStep[];
  final_metrics?: {
    total_prompt_tokens?: number;
    total_completion_tokens?: number;
    total_cached_tokens?: number;
    total_steps?: number;
    extra?: Record<string, unknown>;
  };
  extra?: Record<string, unknown>;
};

export type AgentSessionTurn = {
  key: string;
  number: number | null;
  steps: AgentSessionTrajectoryStep[];
};

export type AgentSessionSummary = {
  status: "ok" | "missing_session" | "missing_file";
  detail?: string;
  command?: string;
  agent: string;
  pane_id: string;
  path: string;
  session?: { value?: string } | null;
  updated_at: string;
  file: { size?: number } | null;
  stats: {
    turns: number;
    records: number;
    token_usage: SessionTokenUsage | null;
  };
  text?: string | null;
  truncated?: boolean;
  trajectory?: AgentSessionTrajectory | null;
};

// Session files are record-oriented, but people reason about an agent run as a
// sequence of turns. Keep setup records together, then start a new turn at
// every user message and attach subsequent agent/tool records to that turn.
export function groupTrajectoryTurns(
  steps: AgentSessionTrajectoryStep[],
): AgentSessionTurn[] {
  const groups: AgentSessionTurn[] = [];
  let current: AgentSessionTurn | null = null;
  let turnNumber = 0;

  for (const step of steps) {
    if (step.source === "user") {
      turnNumber += 1;
      current = {
        key: `turn-${turnNumber}-${step.step_id}`,
        number: turnNumber,
        steps: [step],
      };
      groups.push(current);
      continue;
    }

    if (!current) {
      current = {
        key: `setup-${step.step_id}`,
        number: null,
        steps: [],
      };
      groups.push(current);
    }
    current.steps.push(step);
  }

  return groups;
}

// Build a compact one-line preview for a tool call, preferring the most
// descriptive argument (command, path, pattern, ...) before falling back to
// the agent-provided description or the raw JSON.
const TOOL_ARGUMENT_PREVIEW_KEYS = [
  "command",
  "file_path",
  "path",
  "pattern",
  "query",
  "url",
  "description",
  "prompt",
];

export function toolArgumentsPreview(
  args: Record<string, unknown>,
  description?: string,
  max = 72,
) {
  const truncate = (value: string) => {
    const text = value.replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  };
  for (const key of TOOL_ARGUMENT_PREVIEW_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return truncate(value);
  }
  if (description?.trim()) return truncate(description);
  try {
    return truncate(JSON.stringify(args) ?? "");
  } catch {
    return "";
  }
}

export function firstLinePreview(text: string, max = 96) {
  const line =
    text
      .split("\n")
      .map((value) => value.trim())
      .find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function formatCount(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatCompactNumber(value?: number) {
  if (!value) return "0";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: value >= 10000 ? 1 : 0,
  }).format(value);
}

export function formatOptionalCompact(value?: number) {
  return value === undefined ? "-" : formatCompactNumber(value);
}

export function formatBytes(value?: number) {
  if (!value) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function totalTokens(summary?: AgentSessionSummary | null) {
  const usage = summary?.stats.token_usage;
  if (!usage || usage.total_tokens === null) return undefined;
  return (
    usage.total_tokens ??
    (usage.input_tokens ?? 0) +
      (usage.cached_input_tokens ?? 0) +
      (usage.output_tokens ?? 0) +
      (usage.reasoning_output_tokens ?? 0)
  );
}

export function formatTokenTotal(summary?: AgentSessionSummary | null) {
  const value = totalTokens(summary);
  return value === undefined ? "-" : formatCompactNumber(value);
}

export function tokenUsage(summary?: AgentSessionSummary | null) {
  return summary?.stats.token_usage ?? null;
}

export function downloadSession(pane: Pane, client: ConnectionClient) {
  if (!client.isCurrent()) return;
  const url = new URL(
    connectionHttpPath(
      client.connectionId,
      "/agent-session/download",
      client.serverRuntimeGeneration,
    ),
    window.location.origin,
  );
  url.searchParams.set("pane_id", pane.pane_id);
  if (pane.agent) url.searchParams.set("agent", pane.agent);
  // Empty fallback keeps the server's Content-Disposition filename.
  void downloadFileFromUrl({ url: url.toString(), filename: "" });
}

function sessionAtifFilename(path?: string) {
  const raw =
    path
      ?.split(/[\\/]/)
      .pop()
      ?.replace(/\.[^.]+$/, "") || "session";
  return `${raw.replace(/[^\w.-]+/g, "_")}.atif.json`;
}

export function downloadSessionAtif(
  pane: Pane,
  sessionName: string | undefined,
  client: ConnectionClient,
) {
  if (!client.isCurrent()) return;
  const url = new URL(
    connectionHttpPath(
      client.connectionId,
      "/agent-session/atif",
      client.serverRuntimeGeneration,
    ),
    window.location.origin,
  );
  url.searchParams.set("pane_id", pane.pane_id);
  if (pane.agent) url.searchParams.set("agent", pane.agent);
  void downloadFileFromUrl({
    url: url.toString(),
    filename: sessionAtifFilename(sessionName),
  });
}

export async function exportSessionForConnection(
  pane: Pane,
  client: ConnectionClient,
) {
  if (!client.isCurrent()) return;
  try {
    const summary = (await client.call("agent_session.get", {
      pane_id: pane.pane_id,
      agent: pane.agent,
    })) as AgentSessionSummary;
    if (!client.isCurrent()) return;
    if (summary.status !== "ok") {
      store.notify({
        kind: "error",
        message: "Session unavailable",
        detail: summary.command
          ? `${summary.detail ?? summary.status} (${summary.command})`
          : (summary.detail ?? summary.status),
      });
      return;
    }
    downloadSession(pane, client);
    store.notify({
      kind: "info",
      message: "Session export started",
      detail: summary.path,
      autoDismissMs: 5000,
    });
  } catch (e) {
    if (!client.isCurrent()) return;
    store.notify({
      kind: "error",
      message: "Failed to export session",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}
