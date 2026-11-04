import { Plus, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentTask } from "../../../shared/agentTasks";
import {
  renderJiraTemplate,
  type JiraIssue,
  type JiraPreset,
  type JiraSearchResult,
} from "../../../shared/jira";
import {
  parseAgentIntegrations,
  type AgentIntegration,
} from "../agentIntegrations";
import {
  callJira,
  callTasks,
  jiraPanelAvailable,
  runAgentTask,
  useIssueTrackers,
  type NewTaskRequest,
} from "../issueTrackers";
import { useStoreSelector } from "../store";
import { useConnectionClient } from "../useConnectionClient";
import { CloseButton } from "./CloseButton";
import { focusDialogElement } from "./dialogFocus";
import { JiraPresetIcon } from "./JiraPresetIcon";
import { ThemedSelect } from "./ThemedSelect";
import "./NewTaskDialog.css";

export type NewTaskEdit = { task: AgentTask };
type StartMode = "queue" | "now";
const CUSTOM = "custom";

/** Pure form rules, exported for tests (AC53, AC55, AC60). */
export function canCreateTask(form: {
  title: string;
  prompt: string;
  start: StartMode;
  workspaceId: string;
  agent: string;
}): boolean {
  if (!form.title.trim() || !form.prompt.trim()) return false;
  if (form.start === "now" && (!form.workspaceId || !form.agent)) return false;
  return true;
}

export function presetPrompt(
  preset: JiraPreset | undefined,
  issue: JiraIssue | null,
): string | null {
  return preset ? renderJiraTemplate(preset.template, issue) : null;
}

export function syncBackHint(status: string): string {
  return `Comment on the issue and move it to ${status} when the task completes`;
}

function issueFromTask(task: AgentTask): JiraIssue | null {
  if (!task.jira_key) return null;
  return {
    key: task.jira_key,
    summary: task.jira_issue?.summary ?? "",
    description: "",
    type: task.jira_issue?.type ?? "",
    status: task.jira_issue?.status ?? "",
    status_category: "new",
    priority: null,
    assignee: task.jira_issue?.assignee
      ? { name: task.jira_issue.assignee, initials: "" }
      : null,
    updated_at: "",
    url: "",
  };
}

/** New task / Edit task dialog (AC50–AC60). */
export function NewTaskDialog({
  request,
  edit,
  onClose,
}: {
  request?: NewTaskRequest;
  edit?: NewTaskEdit;
  onClose: () => void;
}) {
  const { jira } = useIssueTrackers();
  const client = useConnectionClient();
  const workspaces = useStoreSelector((state) => state.workspaces);
  const editing = edit?.task ?? null;
  const presets = jira?.presets ?? [];

  const [mode, setMode] = useState<"jira" | "blank">(
    editing ? (editing.jira_key ? "jira" : "blank") : (request?.mode ?? "blank"),
  );
  const [issue, setIssue] = useState<JiraIssue | null>(
    editing ? issueFromTask(editing) : (request?.issue ?? null),
  );
  const initialPreset =
    editing?.preset_id ?? (issue && presets[0] ? presets[0].id : CUSTOM);
  const [presetId, setPresetId] = useState<string>(initialPreset);
  const [title, setTitle] = useState(editing?.title ?? issue?.summary ?? "");
  const [prompt, setPrompt] = useState(
    () =>
      editing?.prompt ??
      presetPrompt(
        presets.find((preset) => preset.id === initialPreset),
        issue,
      ) ??
      "",
  );
  const [workspaceId, setWorkspaceId] = useState(
    editing?.workspace_id ??
      workspaces.find((workspace) => workspace.focused)?.workspace_id ??
      "",
  );
  const [agent, setAgent] = useState(editing?.agent ?? "");
  const [start, setStart] = useState<StartMode>("queue");
  const [syncBack, setSyncBack] = useState(editing?.sync_back ?? false);
  const [agents, setAgents] = useState<AgentIntegration[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<JiraIssue[] | null>(null);
  const [searching, setSearching] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => focusDialogElement(dialogRef.current), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [busy, onClose]);

  useEffect(() => {
    let cancelled = false;
    void client
      .call("integration.list")
      .then((result) => {
        if (cancelled) return;
        const list = parseAgentIntegrations(result).filter((item) => item.available);
        setAgents(list);
        setAgent((current) => current || list[0]?.target || "");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client]);

  const workspaceOptions = useMemo(
    () =>
      workspaces.map((workspace) => ({
        value: workspace.workspace_id,
        label: workspace.cwd || workspace.label,
        detail: workspace.cwd ? workspace.label : undefined,
        keywords: [workspace.label, workspace.cwd ?? ""],
      })),
    [workspaces],
  );

  const choosePreset = (id: string) => {
    setPresetId(id);
    const rendered = presetPrompt(
      presets.find((preset) => preset.id === id),
      issue,
    );
    // "+ Custom" keeps whatever is typed (AC53).
    if (rendered !== null) setPrompt(rendered);
  };

  const chooseIssue = (next: JiraIssue | null) => {
    setIssue(next);
    setResults(null);
    setQuery("");
    if (!next) {
      setSyncBack(false);
      return;
    }
    if (!title.trim()) setTitle(next.summary);
    const preset =
      presets.find((entry) => entry.id === presetId) ?? presets[0];
    if (preset) {
      setPresetId(preset.id);
      setPrompt(renderJiraTemplate(preset.template, next));
    }
  };

  const search = async () => {
    const text = query.trim();
    if (!text) return;
    setSearching(true);
    setError(null);
    try {
      const result = await callJira<JiraSearchResult>("search", {
        filters: { text, sort: { field: "updated", dir: "desc" } },
      });
      setResults(result.issues);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const linkedIssue = mode === "jira" ? issue : null;
  const valid = canCreateTask({ title, prompt, start, workspaceId, agent });

  const submit = async (draft: boolean) => {
    if (busy || (!draft && !valid) || (draft && (!title.trim() || !prompt.trim())))
      return;
    setBusy(true);
    setError(null);
    const fields = {
      title,
      prompt,
      preset_id: presetId === CUSTOM ? null : presetId,
      connection_id: client.connectionId,
      workspace_id: workspaceId || null,
      agent: agent || null,
      sync_back: !!linkedIssue && syncBack,
    };
    try {
      let task: AgentTask;
      if (editing) {
        task = await callTasks("update", {
          id: editing.id,
          patch: { ...fields, status: draft ? "draft" : "queued" },
        });
      } else {
        task = await callTasks("create", {
          ...fields,
          status: draft ? "draft" : "queued",
          jira_key: linkedIssue?.key ?? null,
          jira_issue: linkedIssue
            ? {
                summary: linkedIssue.summary,
                type: linkedIssue.type,
                status: linkedIssue.status,
                assignee: linkedIssue.assignee?.name ?? null,
              }
            : null,
        });
      }
      onClose();
      // The task is saved first, so a failed start leaves it queued (AC59).
      if (!draft && start === "now") void runAgentTask(task, client);
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  };

  const jiraReady = jiraPanelAvailable(jira);

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <div
        ref={dialogRef}
        className="modal new-task-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-task-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2 id="new-task-title">{editing ? "Edit task" : "New task"}</h2>
            <p className="new-task-subtitle">
              Create a task now; hand it to an agent now or later
            </p>
          </div>
          <CloseButton onClick={onClose} />
        </div>

        {!editing ? (
          <div className="new-task-modes" role="radiogroup" aria-label="Start from">
            {(
              [
                ["jira", "From Jira issue"],
                ["blank", "Blank task"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={mode === value}
                className={mode === value ? "is-active" : ""}
                disabled={value === "jira" && !jiraReady && !issue}
                onClick={() => {
                  setMode(value);
                  if (value === "blank") setSyncBack(false);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}

        {mode === "jira" ? (
          issue ? (
            <div className="new-task-issue">
              <span className="new-task-issue-mark" aria-hidden="true">
                J
              </span>
              <div className="new-task-issue-copy">
                <strong>
                  <code>{issue.key}</code> {issue.summary}
                </strong>
                <span>
                  {[issue.type, issue.status, issue.assignee?.name ?? "Unassigned"]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              {!editing ? (
                <button
                  type="button"
                  className="new-task-icon-button"
                  aria-label="Unlink issue"
                  title="Unlink issue"
                  onClick={() => {
                    chooseIssue(null);
                    setMode("blank");
                  }}
                >
                  <span aria-hidden="true">×</span>
                </button>
              ) : null}
            </div>
          ) : (
            <div className="new-task-issue-search">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void search();
                }}
              >
                <Search size={14} aria-hidden="true" />
                <input
                  aria-label="Search Jira issues"
                  placeholder="Search key or text..."
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <button type="submit" disabled={searching || !query.trim()}>
                  {searching ? "Searching..." : "Search"}
                </button>
              </form>
              {results ? (
                <ul className="new-task-issue-results">
                  {results.length === 0 ? <li>No matching issues.</li> : null}
                  {results.map((result) => (
                    <li key={result.key}>
                      <button type="button" onClick={() => chooseIssue(result)}>
                        <code>{result.key}</code> {result.summary}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )
        ) : null}

        <label className="new-task-field">
          <span>Title</span>
          <input
            value={title}
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        <div className="new-task-field">
          <span id="new-task-preset">Preset</span>
          <div className="new-task-presets" role="radiogroup" aria-labelledby="new-task-preset">
            {presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                role="radio"
                aria-checked={presetId === preset.id}
                title={preset.hint}
                className={presetId === preset.id ? "is-active" : ""}
                onClick={() => choosePreset(preset.id)}
              >
                <JiraPresetIcon icon={preset.icon} size={13} /> {preset.label}
              </button>
            ))}
            <button
              type="button"
              role="radio"
              aria-checked={presetId === CUSTOM}
              className={presetId === CUSTOM ? "is-active" : ""}
              onClick={() => choosePreset(CUSTOM)}
            >
              <Plus size={13} aria-hidden="true" /> Custom
            </button>
          </div>
        </div>

        <label className="new-task-field">
          <span>Prompt</span>
          <textarea
            rows={5}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>

        <div className="new-task-pickers">
          <div className="new-task-field">
            <span>Workspace</span>
            <ThemedSelect
              aria-label="Workspace"
              value={workspaceId}
              options={workspaceOptions}
              placeholder="Choose a workspace"
              searchPlaceholder="Search workspaces"
              emptyText="No workspaces"
              onChange={setWorkspaceId}
            />
          </div>
          <div className="new-task-field">
            <span>Agent</span>
            <ThemedSelect
              aria-label="Agent"
              value={agent}
              options={agents.map((item) => ({
                value: item.target,
                label: item.target,
                detail: item.label,
              }))}
              placeholder={agents.length ? "Choose an agent" : "No agents detected"}
              searchPlaceholder="Search agents"
              emptyText="No agents detected"
              onChange={setAgent}
            />
          </div>
          <div className="new-task-field">
            <span>Start</span>
            <ThemedSelect
              aria-label="Start"
              value={start}
              options={[
                { value: "queue", label: "Queue for later" },
                { value: "now", label: "Start now" },
              ]}
              onChange={(value) => setStart(value as StartMode)}
            />
          </div>
        </div>

        {linkedIssue ? (
          <div className="new-task-sync">
            <div>
              <strong id="new-task-sync-label">Sync back to Jira</strong>
              <span id="new-task-sync-hint">
                {syncBackHint(jira?.sync_back_status ?? "In Review")}
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-labelledby="new-task-sync-label"
              aria-describedby="new-task-sync-hint"
              aria-checked={syncBack}
              className={"settings-switch" + (syncBack ? " is-on" : "")}
              onClick={() => setSyncBack(!syncBack)}
            >
              <span />
            </button>
          </div>
        ) : null}

        {error ? (
          <div className="configuration-error" role="alert">
            <span>{error}</span>
          </div>
        ) : null}

        <div className="modal-actions new-task-actions">
          <span className="new-task-linked">
            {linkedIssue ? `Linked to ${linkedIssue.key}` : ""}
          </span>
          <button
            type="button"
            className="ghost"
            disabled={busy || !title.trim() || !prompt.trim()}
            onClick={() => void submit(true)}
          >
            Save as draft
          </button>
          <button
            type="button"
            disabled={busy || !valid}
            onClick={() => void submit(false)}
          >
            {editing ? "Save task" : "Create task"}
          </button>
        </div>
      </div>
    </div>
  );
}
