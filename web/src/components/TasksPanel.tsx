import { CircleAlert, Ellipsis, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  AGENT_TASK_STATUS_LABELS,
  agentTaskFilterCounts,
  agentTaskMatchesFilter,
  type AgentTask,
  type AgentTaskFilter,
} from "../../../shared/agentTasks";
import {
  callTasks,
  issuePanelsVisible,
  openNewTask,
  runAgentTask,
  selectTask,
  useIssueTrackers,
} from "../issueTrackers";
import { elapsedLabel } from "../issueTrackerFormat";
import { store } from "../store";
import { useConnectionClient } from "../useConnectionClient";
import { ConfirmDialog } from "./ModalDialogs";
import { NewTaskDialog, type NewTaskEdit } from "./NewTaskDialog";
import "./TasksPanel.css";

const FILTERS: { value: AgentTaskFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "running", label: "Running" },
  { value: "done", label: "Done" },
];

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** The secondary line: key or Manual, then status or agent, then elapsed. */
export function taskMetaLine(task: AgentTask, now = Date.now()): string {
  const parts = [task.jira_key ?? "Manual"];
  if (task.status === "running") {
    if (task.agent) parts.push(task.agent);
    const elapsed = elapsedLabel(task.started_at, now);
    if (elapsed) parts.push(elapsed);
  } else if (task.status === "queued" || task.status === "draft") {
    parts.push(AGENT_TASK_STATUS_LABELS[task.status]);
    parts.push(task.agent ?? "Unassigned");
  } else {
    parts.push(AGENT_TASK_STATUS_LABELS[task.status]);
  }
  return parts.join(" · ");
}

/** Left sidebar Tasks panel (AC43, AC45–AC48). */
export function TasksPanel() {
  const { jira, tasks, tasksError, tasksPanelOpen, selectedTaskId, supported } =
    useIssueTrackers();
  const client = useConnectionClient();
  const [filter, setFilter] = useState<AgentTaskFilter>("open");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AgentTask | null>(null);
  const [editing, setEditing] = useState<NewTaskEdit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const now = useNow(tasks.some((task) => task.status === "running"));

  // "Open task" from the Jira panel selects a task; make it visible (AC41).
  useEffect(() => {
    if (!selectedTaskId) return;
    const task = tasks.find((entry) => entry.id === selectedTaskId);
    if (task && !agentTaskMatchesFilter(task, filter))
      setFilter(task.status === "done" ? "done" : "open");
    window.requestAnimationFrame(() =>
      listRef.current
        ?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(selectedTaskId)}"]`)
        ?.scrollIntoView({ block: "nearest" }),
    );
  }, [selectedTaskId, tasks, filter]);

  useEffect(() => {
    if (!menuFor) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest?.(".task-row-menu"))
        setMenuFor(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menuFor]);

  if (!supported || !issuePanelsVisible(jira) || !tasksPanelOpen) return null;

  const counts = agentTaskFilterCounts(tasks);
  const visible = tasks.filter((task) => agentTaskMatchesFilter(task, filter));

  const act = async (operation: () => Promise<unknown>) => {
    setMenuFor(null);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const openSession = (task: AgentTask) => {
    if (!task.session) return;
    if (task.connection_id && task.connection_id !== client.connectionId) {
      setError("This task's session is on another server. Switch to it first.");
      return;
    }
    store.focusPane(task.session.pane_id);
  };

  return (
    <div className="panel tasks-panel" aria-label="Tasks">
      <div className="panel-head">
        <h2>Tasks</h2>
        <div className="panel-actions">
          <button
            type="button"
            className="panel-add"
            aria-label="New task"
            title="New task"
            onClick={() => openNewTask({ issue: null, mode: "blank" })}
          >
            <Plus size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="tasks-filters" role="tablist" aria-label="Task status">
        {FILTERS.map((entry) => (
          <button
            key={entry.value}
            type="button"
            role="tab"
            aria-selected={filter === entry.value}
            className={filter === entry.value ? "is-active" : ""}
            onClick={() => setFilter(entry.value)}
          >
            {entry.label} <span>{counts[entry.value]}</span>
          </button>
        ))}
      </div>
      {tasksError || error ? (
        <p className="tasks-error" role="alert">
          {error ?? tasksError}
        </p>
      ) : null}
      <ul className="tasks-list" ref={listRef}>
        {visible.length === 0 ? (
          <li className="tasks-empty">
            {filter === "done" ? "No finished tasks." : "No tasks."}
          </li>
        ) : null}
        {visible.map((task) => (
          <li
            key={task.id}
            data-task-id={task.id}
            data-status={task.status}
            className={`task-row ${selectedTaskId === task.id ? "is-selected" : ""}`}
            onClick={() => selectTask(task.id)}
          >
            <span
              className="task-status-icon"
              data-status={task.status}
              title={AGENT_TASK_STATUS_LABELS[task.status]}
              aria-label={AGENT_TASK_STATUS_LABELS[task.status]}
              role="img"
            />
            <div className="task-copy">
              <strong>{task.title}</strong>
              <span>{taskMetaLine(task, now)}</span>
              {task.last_error ? (
                <span className="task-row-error">
                  <CircleAlert size={11} aria-hidden="true" /> {task.last_error}
                </span>
              ) : null}
              {task.sync_result ? (
                <span
                  className={
                    task.sync_result.ok ? "task-row-sync" : "task-row-error"
                  }
                >
                  {task.sync_result.ok
                    ? `Synced to ${task.jira_key}`
                    : `Jira sync failed: ${task.sync_result.error ?? ""}`}
                </span>
              ) : null}
            </div>
            <div className="task-row-menu">
              <button
                type="button"
                className="panel-action"
                aria-label={`Actions for ${task.title}`}
                aria-haspopup="menu"
                aria-expanded={menuFor === task.id}
                onClick={(event) => {
                  event.stopPropagation();
                  setMenuFor((current) => (current === task.id ? null : task.id));
                }}
              >
                <Ellipsis size={14} aria-hidden="true" />
              </button>
              {menuFor === task.id ? (
                <div className="task-menu" role="menu">
                  {task.status === "draft" || task.status === "queued" ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void act(() => runAgentTask(task, client))}
                    >
                      Start
                    </button>
                  ) : null}
                  {task.session ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuFor(null);
                        openSession(task);
                      }}
                    >
                      Open agent session
                    </button>
                  ) : null}
                  {task.status !== "done" ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() =>
                        void act(() =>
                          callTasks("set_status", { id: task.id, status: "done" }),
                        )
                      }
                    >
                      Mark done
                    </button>
                  ) : (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() =>
                        void act(() =>
                          callTasks("set_status", { id: task.id, status: "queued" }),
                        )
                      }
                    >
                      Reopen
                    </button>
                  )}
                  {task.status === "draft" || task.status === "queued" ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuFor(null);
                        setEditing({ task });
                      }}
                    >
                      Edit
                    </button>
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    className="task-menu-danger"
                    onClick={() => {
                      setMenuFor(null);
                      setConfirmDelete(task);
                    }}
                  >
                    Delete
                  </button>
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete task?"
        message={`"${confirmDelete?.title ?? ""}" will be removed. Its agent session, if any, keeps running.`}
        confirmLabel="Delete"
        danger
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => {
          const task = confirmDelete;
          setConfirmDelete(null);
          if (task) void act(() => callTasks("delete", { id: task.id }));
        }}
      />
      {editing ? (
        <NewTaskDialog edit={editing} onClose={() => setEditing(null)} />
      ) : null}
    </div>
  );
}
