// Agent tasks: work items that can be handed to a coding agent. Not to be
// confused with Ranger's scheduled tasks (server/src/assistant/tasks.ts).

export const AGENT_TASK_STATUSES = [
  "draft",
  "queued",
  "running",
  "needs_review",
  "done",
] as const;
export type AgentTaskStatus = (typeof AGENT_TASK_STATUSES)[number];

export const AGENT_TASK_STATUS_LABELS: Record<AgentTaskStatus, string> = {
  draft: "Draft",
  queued: "Queued",
  running: "Running",
  needs_review: "Needs review",
  done: "Done",
};

export type AgentTaskIssue = {
  summary: string;
  type: string;
  status: string;
  assignee: string | null;
};

export type AgentTaskSession = {
  tab_id: string;
  pane_id: string;
  terminal_id: string;
};

export type AgentTaskSyncResult = {
  ok: boolean;
  at: string;
  error?: string;
};

export type AgentTask = {
  id: string;
  title: string;
  prompt: string;
  preset_id: string | null;
  status: AgentTaskStatus;
  jira_key: string | null;
  jira_issue: AgentTaskIssue | null;
  connection_id: string | null;
  workspace_id: string | null;
  agent: string | null;
  session: AgentTaskSession | null;
  started_at: string | null;
  sync_back: boolean;
  sync_result: AgentTaskSyncResult | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type AgentTaskSnapshot = { revision: number; tasks: AgentTask[] };

export type AgentTaskFilter = "open" | "running" | "done";

export function agentTaskMatchesFilter(
  task: Pick<AgentTask, "status">,
  filter: AgentTaskFilter,
): boolean {
  if (filter === "running") return task.status === "running";
  if (filter === "done") return task.status === "done";
  return task.status !== "done";
}

export function agentTaskFilterCounts(
  tasks: readonly Pick<AgentTask, "status">[],
): Record<AgentTaskFilter, number> {
  const counts = { open: 0, running: 0, done: 0 };
  for (const task of tasks)
    for (const filter of ["open", "running", "done"] as const)
      if (agentTaskMatchesFilter(task, filter)) counts[filter]++;
  return counts;
}

/** The top bar badge: work that is waiting on, or held by, an agent. */
export function activeAgentTaskCount(
  tasks: readonly Pick<AgentTask, "status">[],
): number {
  return tasks.filter(
    (task) =>
      task.status === "queued" ||
      task.status === "running" ||
      task.status === "needs_review",
  ).length;
}

/** Open tasks linked to a Jira issue, newest first. */
export function openTasksForIssue(
  tasks: readonly AgentTask[],
  key: string,
): AgentTask[] {
  return tasks
    .filter((task) => task.jira_key === key && task.status !== "done")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function isAgentTaskSnapshot(value: unknown): value is AgentTaskSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<AgentTaskSnapshot>;
  return (
    typeof snapshot.revision === "number" &&
    Array.isArray(snapshot.tasks) &&
    snapshot.tasks.every(
      (task) =>
        task &&
        typeof task === "object" &&
        typeof (task as AgentTask).id === "string" &&
        AGENT_TASK_STATUSES.includes((task as AgentTask).status),
    )
  );
}
