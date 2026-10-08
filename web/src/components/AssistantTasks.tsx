import { ChevronLeft, LoaderCircle, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  ASSISTANT_MAX_WORKSPACES,
  type AssistantSnapshot,
  type AssistantSource,
  type AssistantTask,
  type AssistantTaskDetail,
  type AssistantTaskInput,
  type AssistantTaskProposal,
  type AssistantTaskSchedule,
  type AssistantWorkspace,
  type AssistantWorkspaceRef,
  isAssistantTaskInput,
} from "../../../shared/assistant";
import { callAssistant, getAssistantTask } from "../assistant";
import type { RangerTaskNotificationTarget } from "../taskNotifications";
import { formatUiDateTime } from "../uiLocale";
import { ActionCard, AssistantMessageActivity } from "./AssistantPanel";
import { MarkdownPreview } from "./markdown";
import { ConfirmDialog } from "./ModalDialogs";
import { ThemedSelect } from "./ThemedSelect";
import "./AssistantTasks.css";

function workspaceKey(ref: AssistantWorkspaceRef) {
  return JSON.stringify([ref.connection_id, ref.workspace_id]);
}

export function taskScheduleLabel(schedule: AssistantTaskSchedule) {
  if (schedule.type === "once") return `Once: ${formatUiDateTime(schedule.at)}`;
  if (schedule.type === "daily")
    return `Daily at ${schedule.time} (${schedule.timezone})`;
  return `Every ${schedule.minutes} minute${schedule.minutes === 1 ? "" : "s"}`;
}

function localDateTime(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

const liveRun = (status: string | undefined) =>
  !!status && ["queued", "running", "waiting"].includes(status);

export function TaskProposalCard({
  proposal,
  busy,
  run,
}: {
  proposal: AssistantTaskProposal;
  busy: boolean;
  run: (action: string, params?: Record<string, unknown>) => Promise<boolean>;
}) {
  return (
    <div
      className="assistant-task-proposal assistant-action-card"
      role="group"
      aria-label="Task proposal"
      tabIndex={-1}
    >
      <div className="assistant-action-head">
        <strong>{proposal.title}</strong>
        <span>
          {proposal.status === "pending"
            ? "Needs confirmation"
            : proposal.status === "confirmed"
              ? "Enabled"
              : "Cancelled"}
        </span>
      </div>
      <p>{taskScheduleLabel(proposal.schedule)}</p>
      <span className="assistant-hint">
        {proposal.scope.length} authorized workspace
        {proposal.scope.length === 1 ? "" : "s"}
      </span>
      <details className="assistant-task-prompt">
        <summary>Task prompt</summary>
        <p>{proposal.prompt}</p>
      </details>
      <span className="assistant-hint">
        {proposal.notification_mode === "agent"
          ? "Ranger decides when to notify"
          : "Notify when each run finishes"}
      </span>
      {proposal.status === "pending" ? (
        <>
          <p className="assistant-hint">
            Confirm to enable this task. Workspace actions still need your
            confirmation.
          </p>
          <div className="assistant-action-buttons">
            <button
              type="button"
              disabled={busy}
              onClick={(event) => {
                event.currentTarget
                  .closest<HTMLElement>(".assistant-task-proposal")
                  ?.focus({ preventScroll: true });
                void run("task.confirm_proposal", { proposal_id: proposal.id });
              }}
            >
              Confirm task
            </button>
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={(event) => {
                event.currentTarget
                  .closest<HTMLElement>(".assistant-task-proposal")
                  ?.focus({ preventScroll: true });
                void run("task.cancel_proposal", { proposal_id: proposal.id });
              }}
            >
              Cancel
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function TaskForm({
  active,
  task,
  workspaces,
  busy,
  ready,
  highPermission = false,
  allWorkspacesAllowed = false,
  onSave,
  onCancel,
  onOpenSettings,
}: {
  active: boolean;
  task?: AssistantTask;
  workspaces: AssistantWorkspace[];
  busy: boolean;
  ready: boolean;
  highPermission?: boolean;
  allWorkspacesAllowed?: boolean;
  onSave: (input: AssistantTaskInput) => Promise<void>;
  onCancel: () => void;
  onOpenSettings: () => void;
}) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [notificationMode, setNotificationMode] = useState<"status" | "agent">(
    task?.notification_mode ?? "status",
  );
  const [scope, setScope] = useState<AssistantWorkspaceRef[]>(
    task?.scope ?? [],
  );
  const [kind, setKind] = useState<AssistantTaskSchedule["type"]>(
    task?.schedule.type ?? "once",
  );
  const [at, setAt] = useState(
    localDateTime(
      task?.schedule.type === "once"
        ? task.schedule.at
        : new Date(Date.now() + 60_000).toISOString(),
    ),
  );
  const [minutes, setMinutes] = useState(
    task?.schedule.type === "interval" ? String(task.schedule.minutes) : "60",
  );
  const [time, setTime] = useState(
    task?.schedule.type === "daily" ? task.schedule.time : "09:00",
  );
  const [timezone, setTimezone] = useState(
    task?.schedule.type === "daily"
      ? task.schedule.timezone
      : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (active) nameRef.current?.focus({ preventScroll: true });
  }, [active]);
  const choices = workspaces;
  const unavailableScope = scope.filter(
    (ref) =>
      !workspaces.some(
        (workspace) => workspaceKey(ref) === workspaceKey(workspace),
      ),
  );
  return (
    <form
      className="assistant-task-form"
      aria-label={task ? "Edit task" : "Create task"}
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || !ready || unavailableScope.length) return;
        const date = new Date(at);
        const schedule: AssistantTaskSchedule =
          kind === "once"
            ? {
                type: "once",
                at: Number.isFinite(date.getTime()) ? date.toISOString() : "",
              }
            : kind === "daily"
              ? { type: "daily", time, timezone: timezone.trim() }
              : { type: "interval", minutes: Number(minutes) };
        const input = {
          title: title.trim(),
          prompt: prompt.trim(),
          scope,
          ...(task?.mentions
            ? {
                mentions: task.mentions.filter((mention) =>
                  scope.some(
                    (ref) => workspaceKey(ref) === workspaceKey(mention),
                  ),
                ),
              }
            : {}),
          schedule,
          ...(notificationMode === "agent" ||
          task?.notification_mode !== undefined
            ? { notification_mode: notificationMode }
            : {}),
        };
        if (!isAssistantTaskInput(input)) {
          setError(
            "Enter a name, prompt, valid schedule and at least one workspace.",
          );
          return;
        }
        setError(null);
        await onSave(input);
      }}
    >
      <div className="assistant-section-heading">
        <h3>{task ? "Edit task" : "New task"}</h3>
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          <ChevronLeft size={13} /> Back
        </button>
      </div>
      <p className="assistant-hint">
        Tasks run on the bridge in their own conversations. Saving uses the
        current permission mode:{" "}
        {highPermission
          ? "high permission. Supported workspace operations execute automatically while the global mode stays enabled."
          : "manual. Workspace operations need your confirmation."}
      </p>
      {!ready ? (
        <div className="assistant-setup-notice">
          <span>
            Connect a provider and choose a model before saving a task.
          </span>
          <button type="button" className="ghost" onClick={onOpenSettings}>
            Model settings
          </button>
        </div>
      ) : null}
      <fieldset disabled={busy}>
        <label className="form-field">
          <span>Name</span>
          <input
            ref={nameRef}
            aria-label="Task name"
            required
            maxLength={100}
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
        </label>
        <label className="form-field">
          <span>Prompt</span>
          <textarea
            aria-label="Task prompt"
            required
            rows={5}
            maxLength={32_000}
            value={prompt}
            onChange={(event) => setPrompt(event.currentTarget.value)}
          />
          {task?.mentions?.length ? (
            <small className="assistant-hint">
              References:{" "}
              {task.mentions
                .filter((mention) =>
                  scope.some(
                    (ref) => workspaceKey(ref) === workspaceKey(mention),
                  ),
                )
                .map(
                  (mention) => `${mention.label} (${mention.connection_label})`,
                )
                .join(", ") || "None in the selected workspaces"}
              .
            </small>
          ) : null}
        </label>
        <div className="form-field">
          <span>Notifications</span>
          <ThemedSelect
            aria-label="Task notifications"
            value={notificationMode}
            options={[
              { value: "status", label: "Notify when each run finishes" },
              { value: "agent", label: "Let Ranger decide" },
            ]}
            disabled={busy}
            onChange={(value) =>
              setNotificationMode(value as "status" | "agent")
            }
          />
          <small className="assistant-hint">
            Ranger can send a custom notice when needed. Let Ranger decide keeps
            routine checks quiet; failed runs and action confirmations still
            notify.
          </small>
        </div>
        <div className="form-field">
          <span>Schedule</span>
          <ThemedSelect
            aria-label="Task schedule"
            value={kind}
            options={[
              { value: "once", label: "Once" },
              { value: "daily", label: "Daily" },
              { value: "interval", label: "Interval" },
            ]}
            disabled={busy}
            onChange={(value) =>
              setKind(value as AssistantTaskSchedule["type"])
            }
          />
        </div>
        {kind === "once" ? (
          <label className="form-field">
            <span>Run at (your local time)</span>
            <input
              type="datetime-local"
              aria-label="Run at"
              required
              value={at}
              onChange={(event) => setAt(event.currentTarget.value)}
            />
          </label>
        ) : kind === "daily" ? (
          <>
            <label className="form-field">
              <span>Time</span>
              <input
                type="time"
                aria-label="Daily time"
                required
                value={time}
                onChange={(event) => setTime(event.currentTarget.value)}
              />
            </label>
            <label className="form-field">
              <span>Timezone</span>
              <input
                aria-label="Task timezone"
                required
                value={timezone}
                placeholder="Europe/London"
                onChange={(event) => setTimezone(event.currentTarget.value)}
              />
            </label>
          </>
        ) : (
          <label className="form-field">
            <span>Minutes between runs</span>
            <input
              type="number"
              aria-label="Interval minutes"
              required
              min={1}
              max={525600}
              step={1}
              value={minutes}
              onChange={(event) => setMinutes(event.currentTarget.value)}
            />
          </label>
        )}
        <fieldset className="assistant-task-scope">
          <legend>Workspaces</legend>
          {allWorkspacesAllowed ? (
            <p className="assistant-hint">
              All available workspaces are allowed. Choose the workspaces this
              task should use; its scope stays fixed when new workspaces appear.
            </p>
          ) : null}
          {unavailableScope.length ? (
            <div className="assistant-setup-notice" role="alert">
              <span>
                {unavailableScope.length} selected workspace
                {unavailableScope.length === 1 ? " is" : "s are"} unavailable or
                no longer allowed. The saved scope is unchanged. Reconnect or
                refresh workspace settings, or remove these selections before
                saving.
              </span>
              <button
                type="button"
                className="ghost"
                onClick={() =>
                  setScope(
                    scope.filter((ref) => !unavailableScope.includes(ref)),
                  )
                }
              >
                Remove unavailable selections
              </button>
            </div>
          ) : null}
          <div className="assistant-workspaces">
            {choices.map((workspace) => {
              const checked = scope.some(
                (ref) => workspaceKey(ref) === workspaceKey(workspace),
              );
              return (
                <label
                  key={workspaceKey(workspace)}
                  className="assistant-workspace-choice"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={
                      !checked && scope.length >= ASSISTANT_MAX_WORKSPACES
                    }
                    onChange={() =>
                      setScope(
                        checked
                          ? scope.filter(
                              (ref) =>
                                workspaceKey(ref) !== workspaceKey(workspace),
                            )
                          : [
                              ...scope,
                              {
                                connection_id: workspace.connection_id,
                                workspace_id: workspace.workspace_id,
                              },
                            ],
                      )
                    }
                  />
                  <span>
                    {workspace.label}
                    <small>{workspace.connection_label}</small>
                  </span>
                </label>
              );
            })}
            {!choices.length ? (
              <span className="assistant-hint">
                {allWorkspacesAllowed
                  ? "No connected workspaces available. Reconnect or refresh in Ranger settings."
                  : "Allow connected workspaces in Ranger settings first."}
              </span>
            ) : null}
          </div>
        </fieldset>
      </fieldset>
      {error ? (
        <p className="assistant-task-error" role="alert">
          {error}
        </p>
      ) : null}
      {task?.status === "paused" ? (
        <p className="assistant-hint">
          This task will stay paused after saving.
        </p>
      ) : null}
      <div className="assistant-task-buttons">
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={
            busy ||
            !ready ||
            !title.trim() ||
            !prompt.trim() ||
            !scope.length ||
            !!unavailableScope.length
          }
        >
          {task ? "Save changes" : "Save and enable"}
        </button>
      </div>
    </form>
  );
}

export function AssistantTasks({
  active = true,
  requestedTask,
  onRequestedTaskHandled,
  snapshot,
  connected,
  workspaces,
  onOpenSettings,
  onOpenSource,
}: {
  active?: boolean;
  requestedTask?: RangerTaskNotificationTarget | null;
  onRequestedTaskHandled?: () => void;
  snapshot: AssistantSnapshot;
  connected: boolean;
  workspaces: AssistantWorkspace[];
  onOpenSettings: () => void;
  onOpenSource: (source: AssistantSource) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | undefined>();
  const [detail, setDetail] = useState<AssistantTaskDetail | null>(null);
  const [editor, setEditor] = useState<"new" | "edit" | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<"cancel" | "delete" | null>(
    null,
  );
  const [showCancelled, setShowCancelled] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const pending = useRef(false);
  const cancelDetailRequest = useRef<(() => void) | null>(null);
  const creationRequest = useRef<{ key: string; id: string } | null>(null);
  const tasks = snapshot.tasks ?? [];
  const visibleTasks = tasks.filter(
    (item) => showCancelled || item.status !== "cancelled",
  );
  const summary = tasks.find((task) => task.id === selectedId);
  const selectedAvailable = !!summary;
  const requestedTaskAvailable =
    !!requestedTask && tasks.some((task) => task.id === requestedTask.taskId);
  useEffect(() => {
    if (!requestedTask) return;
    cancelDetailRequest.current?.();
    setSelectedId(null);
    setRunId(undefined);
    setDetail(null);
    setEditor(null);
    setConfirmation(null);
    onRequestedTaskHandled?.();
    if (!requestedTaskAvailable) {
      setError("This Ranger task is no longer available.");
      return;
    }
    setSelectedId(requestedTask.taskId);
    setRunId(requestedTask.runId);
    setError(null);
    setRefresh((value) => value + 1);
  }, [requestedTask, requestedTaskAvailable, onRequestedTaskHandled]);
  const signature = summary
    ? JSON.stringify([
        summary.updated_at,
        summary.status,
        summary.current_run?.id,
        summary.current_run?.status,
        summary.last_run?.id,
        summary.last_run?.status,
      ])
    : "";
  const ready =
    connected &&
    !!snapshot.config.provider &&
    !!snapshot.config.model &&
    snapshot.providers.some(
      (provider) =>
        provider.id === snapshot.config.provider && provider.configured,
    ) &&
    snapshot.models.some(
      (model) =>
        model.provider === snapshot.config.provider &&
        model.id === snapshot.config.model,
    ) &&
    !["waiting", "working"].includes(snapshot.auth?.status ?? "");
  useEffect(() => {
    if (selectedId && !selectedAvailable && !busy) {
      setSelectedId(null);
      setRunId(undefined);
      setDetail(null);
      setEditor(null);
      setError(null);
      setConfirmation(null);
    }
  }, [selectedId, selectedAvailable, busy]);
  useEffect(() => {
    if (
      !active ||
      !selectedId ||
      !selectedAvailable ||
      !connected ||
      editor ||
      busy
    )
      return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll = liveRun(summary?.current_run?.status);
    setLoading(true);
    const load = async () => {
      try {
        const value = await getAssistantTask(selectedId, runId);
        if (cancelled) return;
        setDetail(value);
        setError(null);
        if (!runId && !value.run && value.runs.length)
          setRunId(
            value.task.current_run?.id ??
              value.task.last_run?.id ??
              value.runs[0].id,
          );
        poll =
          liveRun(value.task.current_run?.status) || liveRun(value.run?.status);
      } catch (cause) {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) {
          setLoading(false);
          if (poll) timer = setTimeout(() => void load(), 1000);
        }
      }
    };
    const cancel = () => {
      cancelled = true;
      clearTimeout(timer);
    };
    cancelDetailRequest.current = cancel;
    void load();
    return cancel;
  }, [
    active,
    selectedId,
    selectedAvailable,
    runId,
    connected,
    snapshot.instance_id,
    signature,
    summary?.current_run?.status,
    refresh,
    editor,
    busy,
  ]);
  const select = (id: string | null) => {
    cancelDetailRequest.current?.();
    setSelectedId(id);
    setRunId(undefined);
    setDetail(null);
    setEditor(null);
    setError(null);
    creationRequest.current = null;
  };
  const mutate = async (action: string, params: Record<string, unknown>) => {
    if (pending.current || !connected) return null;
    cancelDetailRequest.current?.();
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const value = (await callAssistant(
        `task.${action}`,
        params,
      )) as AssistantSnapshot;
      setRefresh((value) => value + 1);
      return value;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const task = detail?.task ?? summary;
  const selectedRun = detail?.run;
  const runBusy =
    ["queued", "running"].includes(selectedRun?.status ?? "") ||
    !!selectedRun?.messages.some((message) =>
      message.actions?.some((action) => action.status === "executing"),
    );
  return (
    <div className="assistant-tasks" aria-label="Ranger tasks" hidden={!active}>
      {error ? (
        <p className="assistant-task-error" role="alert">
          {error}
        </p>
      ) : null}
      {editor ? (
        <TaskForm
          active={active}
          key={editor === "edit" ? task?.id : "new"}
          task={editor === "edit" ? task : undefined}
          workspaces={workspaces}
          busy={busy || !connected}
          ready={ready}
          highPermission={snapshot.config.approval_mode === "auto"}
          allWorkspacesAllowed={
            snapshot.config.approval_mode === "auto" &&
            snapshot.config.workspace_scope === "all"
          }
          onOpenSettings={onOpenSettings}
          onCancel={() => setEditor(null)}
          onSave={async (input) => {
            const key = JSON.stringify(input);
            if (editor === "new" && creationRequest.current?.key !== key)
              creationRequest.current = { key, id: crypto.randomUUID() };
            const result = await mutate(
              editor === "edit" ? "update" : "create",
              {
                ...input,
                ...(editor === "edit"
                  ? { task_id: selectedId }
                  : { request_id: creationRequest.current!.id }),
              },
            );
            if (!result) return;
            const id =
              editor === "edit"
                ? selectedId
                : result.tasks?.find(
                    (item) =>
                      !tasks.some((previous) => previous.id === item.id),
                  )?.id;
            select(id ?? null);
          }}
        />
      ) : !selectedId ? (
        <>
          <div className="assistant-section-heading">
            <h3>Tasks</h3>
            <button
              type="button"
              className="ghost"
              disabled={!connected || snapshot.tasks === undefined}
              onClick={() => {
                creationRequest.current = null;
                setEditor("new");
              }}
            >
              <Plus size={13} /> New task
            </button>
          </div>
          <p className="assistant-hint">
            Runs continue in the background. Open a task to see its history and
            results.
          </p>
          {tasks.some((item) => item.status === "cancelled") ? (
            <label className="assistant-task-filter">
              <input
                type="checkbox"
                checked={showCancelled}
                onChange={(event) =>
                  setShowCancelled(event.currentTarget.checked)
                }
              />
              Show cancelled
            </label>
          ) : null}
          {visibleTasks.length ? (
            <ul className="assistant-task-list">
              {visibleTasks.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="ghost assistant-task-row"
                    onClick={() => select(item.id)}
                  >
                    <div>
                      <strong>{item.title}</strong>
                      <span
                        className={`assistant-task-state is-${item.status}`}
                      >
                        {item.status}
                      </span>
                    </div>
                    <span>{taskScheduleLabel(item.schedule)}</span>
                    <small>
                      {item.current_run
                        ? `Current: ${item.current_run.status}`
                        : item.last_run
                          ? `Last: ${item.last_run.status}`
                          : "No runs yet"}
                    </small>
                    <small>
                      {item.next_run_at
                        ? `Next: ${formatUiDateTime(item.next_run_at)}`
                        : "No upcoming run"}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="assistant-panel-empty">
              <strong>
                {snapshot.tasks === undefined
                  ? "Update the bridge to use tasks"
                  : tasks.length
                    ? "No active tasks"
                    : "No tasks yet"}
              </strong>
              <span>
                Create a task for a one-time or recurring workspace check.
              </span>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="assistant-section-heading">
            <button
              type="button"
              className="ghost"
              onClick={() => select(null)}
            >
              <ChevronLeft size={13} /> All tasks
            </button>
            {task ? (
              <button
                type="button"
                className="ghost"
                disabled={busy || !connected || task.status === "cancelled"}
                onClick={() => setEditor("edit")}
              >
                Edit
              </button>
            ) : null}
          </div>
          {task ? (
            <>
              <div className="assistant-task-heading">
                <h3>{task.title}</h3>
                <span className={`assistant-task-state is-${task.status}`}>
                  {task.status}
                </span>
              </div>
              <p className="assistant-hint">
                {taskScheduleLabel(task.schedule)}
                {task.next_run_at
                  ? ` / Next: ${formatUiDateTime(task.next_run_at)}`
                  : " / No upcoming run"}
              </p>
              <span className="assistant-hint">
                {task.workspaces
                  .map((ref) => `${ref.connection_label} / ${ref.label}`)
                  .join(", ")}{" "}
                / {task.model.id}
              </span>
              <details className="assistant-task-prompt">
                <summary>Task prompt</summary>
                <p>{task.prompt}</p>
              </details>
              <span className="assistant-hint">
                {task.approval_mode === "auto"
                  ? snapshot.config.approval_mode === "auto"
                    ? "High permission: supported operations execute automatically"
                    : "High permission saved; global mode is off, so operations need confirmation"
                  : "Manual permission: operations need confirmation"}
              </span>
              <span className="assistant-hint">
                {task.notification_mode === "agent"
                  ? "Ranger decides when to notify"
                  : "Notify when each run finishes"}
              </span>
              <div className="assistant-task-buttons">
                <button
                  type="button"
                  disabled={
                    busy ||
                    !connected ||
                    task.status === "cancelled" ||
                    liveRun(task.current_run?.status)
                  }
                  onClick={() => void mutate("run_now", { task_id: task.id })}
                >
                  Run now
                </button>
                {task.status !== "cancelled" ? (
                  <>
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy || !connected}
                      onClick={() =>
                        void mutate(
                          task.status === "paused" ? "resume" : "pause",
                          { task_id: task.id },
                        )
                      }
                    >
                      {task.status === "paused" ? "Resume" : "Pause"}
                    </button>
                    <button
                      type="button"
                      className="ghost danger-text"
                      disabled={busy || !connected}
                      onClick={() => setConfirmation("cancel")}
                    >
                      Cancel task
                    </button>
                  </>
                ) : null}
                {task.status === "cancelled" && !task.current_run ? (
                  <button
                    type="button"
                    className="ghost danger-text"
                    disabled={busy || !connected}
                    onClick={() => setConfirmation("delete")}
                  >
                    Delete task
                  </button>
                ) : null}
                {liveRun(task.current_run?.status) ? (
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy || !connected}
                    onClick={() => void mutate("stop", { task_id: task.id })}
                  >
                    Stop run
                  </button>
                ) : null}
              </div>
            </>
          ) : null}
          {loading && (!detail || (runId && !selectedRun)) ? (
            <p className="assistant-hint" role="status">
              <LoaderCircle size={13} className="assistant-spinner" /> Loading
              {runId ? " run history" : " task history"}
            </p>
          ) : null}
          {detail ? (
            <>
              <div className="form-field">
                <span>Run history</span>
                {detail.runs.length ? (
                  <ThemedSelect
                    aria-label="Task run"
                    value={selectedRun?.id ?? ""}
                    options={detail.runs.map((run) => ({
                      value: run.id,
                      label: `${formatUiDateTime(run.scheduled_at)} / ${run.status}`,
                    }))}
                    onChange={(id) => {
                      setRunId(id);
                      setDetail(null);
                    }}
                  />
                ) : (
                  <span className="assistant-hint">No runs yet.</span>
                )}
              </div>
              {selectedRun ? (
                <div
                  className="assistant-task-run"
                  aria-label="Task run output"
                  aria-busy={liveRun(selectedRun.status)}
                >
                  <div className="assistant-task-run-status" role="status">
                    Run {selectedRun.status}
                    {selectedRun.started_at
                      ? ` / Started ${formatUiDateTime(selectedRun.started_at)}`
                      : ""}
                  </div>
                  {selectedRun.error ? (
                    <p className="assistant-task-error" role="alert">
                      {selectedRun.error}
                    </p>
                  ) : null}
                  {selectedRun.messages.map((message) => (
                    <section
                      className={`assistant-message is-${message.role}`}
                      key={message.id}
                      aria-label={`${message.role === "assistant" ? "Ranger" : "Task"} message`}
                    >
                      <div className="assistant-message-head">
                        <strong>
                          {message.role === "assistant"
                            ? "Ranger"
                            : "Task prompt"}
                        </strong>
                        <time dateTime={message.sent_at}>
                          {formatUiDateTime(message.sent_at)}
                        </time>
                      </div>
                      {message.role === "assistant" ? (
                        message.text ? (
                          <MarkdownPreview
                            text={message.text}
                            className="assistant-markdown"
                            breaks
                            imageUrlResolver={() => null}
                          />
                        ) : (
                          <span className="assistant-hint">
                            {liveRun(selectedRun.status)
                              ? "Working..."
                              : "No response text was received."}
                          </span>
                        )
                      ) : (
                        <p className="assistant-user-text">{message.text}</p>
                      )}
                      {message.actions?.map((action) => (
                        <ActionCard
                          key={action.id}
                          action={action}
                          busy={busy || !connected}
                          running={runBusy}
                          run={async (name, params) =>
                            !!(await mutate(name, {
                              ...params,
                              task_id: detail.task.id,
                              run_id: selectedRun.id,
                            }))
                          }
                        />
                      ))}
                      {message.task_proposals?.map((proposal) => (
                        <TaskProposalCard
                          key={proposal.id}
                          proposal={proposal}
                          busy={busy || !connected}
                          run={async (name, params) =>
                            !!(await mutate(
                              name.replace(/^task\./, ""),
                              params ?? {},
                            ))
                          }
                        />
                      ))}
                      {message.tools.length || message.sources.length ? (
                        <AssistantMessageActivity
                          message={message}
                          running={
                            selectedRun.status === "running" &&
                            message ===
                              selectedRun.messages[
                                selectedRun.messages.length - 1
                              ]
                          }
                          onOpenSource={onOpenSource}
                        />
                      ) : null}
                    </section>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
          <ConfirmDialog
            open={active && confirmation !== null}
            title={
              confirmation === "delete"
                ? "Delete this task?"
                : "Cancel this task?"
            }
            message={
              confirmation === "delete"
                ? "Permanently delete this task and all of its run history."
                : "Stop its current run and cancel future runs. Run history will stay available."
            }
            confirmLabel={
              confirmation === "delete" ? "Delete task" : "Cancel task"
            }
            danger
            onClose={() => setConfirmation(null)}
            onConfirm={() => {
              const action = confirmation;
              setConfirmation(null);
              if (task && action)
                void (async () => {
                  const result = await mutate(action, { task_id: task.id });
                  if (result && action === "delete") select(null);
                })();
            }}
          />
        </>
      )}
    </div>
  );
}
