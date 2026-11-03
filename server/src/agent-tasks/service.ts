import { randomUUID } from "node:crypto";
import type {
  AgentTask,
  AgentTaskIssue,
  AgentTaskSession,
  AgentTaskSnapshot,
} from "../../../shared/agentTasks";
import type { AgentTaskStorage } from "./storage";

const LIMITS = { title: 200, prompt: 20_000, id: 256, field: 512 };
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;

export type AgentTaskEvent = {
  connectionId: string;
  paneId?: string;
  kind: "completed" | "blocked";
};

export type AgentTaskServiceOptions = {
  storage: AgentTaskStorage;
  publish(snapshot: AgentTaskSnapshot): void;
  /** Comments on and transitions the linked issue; throws with a message. */
  syncBack?(task: AgentTask): Promise<void>;
  now?: () => number;
  id?: () => string;
  /** Coalescing delay for snapshot pushes; Ranger uses the same 80 ms. */
  publishDelayMs?: number;
};

function text(value: unknown, field: string, max: number, required = true) {
  const result = typeof value === "string" ? value.trim() : "";
  if (required && !result) throw new Error(`${field} is required.`);
  if (result.length > max)
    throw new Error(`${field} is limited to ${max} characters.`);
  return result;
}

function optionalId(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > LIMITS.id)
    throw new Error(`Invalid ${field}.`);
  return value;
}

function issueKey(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const key = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!ISSUE_KEY_RE.test(key)) throw new Error("Invalid Jira issue key.");
  return key;
}

function issueSnapshot(value: unknown): AgentTaskIssue | null {
  if (!value || typeof value !== "object") return null;
  const issue = value as Record<string, unknown>;
  const field = (name: string) =>
    typeof issue[name] === "string"
      ? (issue[name] as string).slice(0, LIMITS.field)
      : "";
  return {
    summary: field("summary"),
    type: field("type"),
    status: field("status"),
    assignee:
      typeof issue.assignee === "string"
        ? issue.assignee.slice(0, LIMITS.field)
        : null,
  };
}

function session(value: unknown): AgentTaskSession {
  const raw = (value ?? {}) as Record<string, unknown>;
  const ids = ["tab_id", "pane_id", "terminal_id"] as const;
  for (const key of ids)
    if (typeof raw[key] !== "string" || !raw[key] || (raw[key] as string).length > LIMITS.id)
      throw new Error("Invalid agent session.");
  return {
    tab_id: raw.tab_id as string,
    pane_id: raw.pane_id as string,
    terminal_id: raw.terminal_id as string,
  };
}

export function syncBackComment(task: AgentTask): string {
  return `Roamgate task "${task.title}" was completed${task.agent ? ` by ${task.agent}` : ""}.`;
}

export function createAgentTaskService(options: AgentTaskServiceOptions) {
  const now = options.now ?? Date.now;
  const newId = options.id ?? randomUUID;
  const tasks = new Map(options.storage.list().map((task) => [task.id, task]));
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function snapshot(): AgentTaskSnapshot {
    return {
      revision,
      tasks: [...tasks.values()].sort(
        (a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id),
      ),
    };
  }

  function publish() {
    revision++;
    if (disposed) return;
    const delay = options.publishDelayMs ?? 80;
    if (delay <= 0) {
      options.publish(snapshot());
      return;
    }
    timer ??= setTimeout(() => {
      timer = undefined;
      if (!disposed) options.publish(snapshot());
    }, delay);
  }

  /** Commits before publishing, as Ranger does. */
  function save(task: AgentTask): AgentTask {
    options.storage.put(task);
    tasks.set(task.id, task);
    publish();
    return task;
  }

  function get(id: unknown): AgentTask {
    const task = typeof id === "string" ? tasks.get(id) : undefined;
    if (!task) throw new Error("That task no longer exists.");
    return task;
  }

  const stamp = () => new Date(now()).toISOString();

  function runSyncBack(task: AgentTask) {
    if (!options.syncBack) return;
    void options.syncBack(task).then(
      () => ({ ok: true, at: stamp() }),
      (error: unknown) => ({
        ok: false,
        at: stamp(),
        error: (error as Error).message || "Sync back failed.",
      }),
    ).then((result) => {
      const current = tasks.get(task.id);
      if (!current) return;
      save({ ...current, sync_result: result, updated_at: stamp() });
    });
  }

  function create(params: Record<string, unknown>): AgentTask {
    const status = params.status === "queued" ? "queued" : "draft";
    const jiraKey = issueKey(params.jira_key);
    const at = stamp();
    return save({
      id: newId(),
      title: text(params.title, "Title", LIMITS.title),
      prompt: text(params.prompt, "Prompt", LIMITS.prompt),
      preset_id: optionalId(params.preset_id, "preset"),
      status,
      jira_key: jiraKey,
      jira_issue: jiraKey ? issueSnapshot(params.jira_issue) : null,
      connection_id: optionalId(params.connection_id, "connection"),
      workspace_id: optionalId(params.workspace_id, "workspace"),
      agent: optionalId(params.agent, "agent"),
      session: null,
      started_at: null,
      sync_back: jiraKey !== null && params.sync_back === true,
      sync_result: null,
      last_error: null,
      created_at: at,
      updated_at: at,
    });
  }

  function update(params: Record<string, unknown>): AgentTask {
    const task = get(params.id);
    if (task.status !== "draft" && task.status !== "queued")
      throw new Error("Only draft or queued tasks can be edited.");
    const patch = (params.patch ?? {}) as Record<string, unknown>;
    const next = { ...task };
    if ("title" in patch) next.title = text(patch.title, "Title", LIMITS.title);
    if ("prompt" in patch)
      next.prompt = text(patch.prompt, "Prompt", LIMITS.prompt);
    if ("preset_id" in patch)
      next.preset_id = optionalId(patch.preset_id, "preset");
    if ("connection_id" in patch)
      next.connection_id = optionalId(patch.connection_id, "connection");
    if ("workspace_id" in patch)
      next.workspace_id = optionalId(patch.workspace_id, "workspace");
    if ("agent" in patch) next.agent = optionalId(patch.agent, "agent");
    if ("sync_back" in patch)
      next.sync_back = next.jira_key !== null && patch.sync_back === true;
    if (patch.status === "queued" || patch.status === "draft")
      next.status = patch.status;
    next.updated_at = stamp();
    return save(next);
  }

  function linkSession(params: Record<string, unknown>): AgentTask {
    const task = get(params.id);
    if (task.status !== "draft" && task.status !== "queued")
      throw new Error("This task has already been started.");
    return save({
      ...task,
      status: "running",
      connection_id: optionalId(params.connection_id, "connection"),
      workspace_id: optionalId(params.workspace_id, "workspace"),
      agent: optionalId(params.agent, "agent"),
      session: session(params.session),
      started_at: stamp(),
      last_error: null,
      updated_at: stamp(),
    });
  }

  function setStatus(params: Record<string, unknown>): AgentTask {
    const task = get(params.id);
    if (params.status === "done") {
      if (task.status === "done") return task;
      const done = save({ ...task, status: "done", updated_at: stamp() });
      // At most one attempt per task, so reopening never comments twice (AC62).
      if (done.sync_back && done.jira_key && done.sync_result === null)
        runSyncBack(done);
      return done;
    }
    if (params.status === "queued") {
      const error =
        typeof params.error === "string" && params.error.trim()
          ? params.error.trim().slice(0, 2000)
          : null;
      if (task.status === "done") {
        // Reopen: back in the queue, ready to start a fresh session.
        return save({
          ...task,
          status: "queued",
          session: null,
          started_at: null,
          last_error: null,
          updated_at: stamp(),
        });
      }
      if (task.status === "draft" || task.status === "queued")
        return save({ ...task, status: "queued", last_error: error, updated_at: stamp() });
      throw new Error("A started task cannot go back to the queue.");
    }
    throw new Error("Unsupported task status.");
  }

  function remove(params: Record<string, unknown>) {
    const task = get(params.id);
    options.storage.remove(task.id);
    tasks.delete(task.id);
    publish();
    return { ok: true };
  }

  return {
    async handle(method: string, params: Record<string, unknown>) {
      switch (method) {
        case "bridge.tasks.list":
          return snapshot();
        case "bridge.tasks.create":
          return create(params);
        case "bridge.tasks.update":
          return update(params);
        case "bridge.tasks.link_session":
          return linkSession(params);
        case "bridge.tasks.set_status":
          return setStatus(params);
        case "bridge.tasks.delete":
          return remove(params);
        default:
          throw new Error(`unknown task method: ${method}`);
      }
    },
    /** An agent finished a turn or needs input in a task's pane (AC49). */
    onTaskEvent(event: AgentTaskEvent) {
      if (!event.paneId) return;
      for (const task of tasks.values())
        if (
          task.status === "running" &&
          task.connection_id === event.connectionId &&
          task.session?.pane_id === event.paneId
        )
          save({ ...task, status: "needs_review", updated_at: stamp() });
    },
    snapshot,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      options.storage.close();
    },
  };
}
export type AgentTaskService = ReturnType<typeof createAgentTaskService>;
