import {
  ArrowDownWideNarrow,
  ArrowUpRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code,
  Maximize2,
  Minimize2,
  PanelBottom,
  PanelRight,
  Plus,
  RefreshCw,
  Search,
  Star,
  SquareCheck,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AGENT_TASK_STATUS_LABELS,
  openTasksForIssue,
} from "../../../shared/agentTasks";
import {
  JIRA_PAGE_SIZE,
  isJiraAuthError,
  jiraSiteName,
  type JiraFilters,
  type JiraIssue,
  type JiraSavedView,
  type JiraSearchResult,
  type JiraSortField,
} from "../../../shared/jira";
import {
  callJira,
  openNewTask,
  requestJiraSettings,
  revealTask,
  setJiraDock,
  setJiraDockSize,
  setJiraPanelExpanded,
  setJiraPanelOpen,
  useIssueTrackers,
} from "../issueTrackers";
import { initialJiraQuery, relativeAge } from "../issueTrackerFormat";
import {
  JIRA_DOCK_KEYBOARD_STEP,
  clampJiraDockSize,
  jiraDockSize,
} from "../jiraDock";
import {
  addSavedView,
  loadSavedViews,
  removeSavedView,
  storeSavedViews,
} from "../jiraSavedViews";
import { CloseButton } from "./CloseButton";
import { TextInputDialog } from "./ModalDialogs";
import { ThemedSelect } from "./ThemedSelect";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import "./JiraIssuesPanel.css";

const COMMON_TYPES = ["Bug", "Task", "Story", "Epic", "Sub-task"];
const SORT_LABELS: Record<JiraSortField, string> = {
  updated: "Updated",
  created: "Created",
  priority: "Priority",
  key: "Key",
};

/** Token pagination: Jira Cloud returns no total, only the next token (AC38). */
export type PageState = { tokens: (string | null)[]; index: number };
export const firstPage: PageState = { tokens: [null], index: 0 };

export function nextPage(state: PageState, nextToken: string): PageState {
  const tokens = state.tokens.slice(0, state.index + 1);
  tokens.push(nextToken);
  return { tokens, index: state.index + 1 };
}

export function previousPage(state: PageState): PageState {
  return state.index > 0 ? { ...state, index: state.index - 1 } : state;
}

export function pageRange(index: number, count: number): string {
  if (count === 0) return "0 results";
  const start = index * JIRA_PAGE_SIZE + 1;
  return `${start}–${start + count - 1}`;
}

function MultiSelect({
  label,
  options,
  value,
  disabled,
  onChange,
}: {
  label: string;
  options: string[];
  value: string[];
  disabled?: boolean;
  onChange: (value: string[]) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`jira-filter ${value.length ? "is-set" : ""}`}
          disabled={disabled}
          aria-label={`${label} filter${value.length ? `, ${value.length} selected` : ""}`}
        >
          {label}
          {value.length ? <strong>{value.length}</strong> : null}
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="jira-multiselect" align="start" aria-label={label}>
        {options.length === 0 ? (
          <p className="jira-multiselect-empty">No options yet.</p>
        ) : null}
        {options.map((option) => (
          <label key={option}>
            <input
              type="checkbox"
              checked={value.includes(option)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...value, option]
                    : value.filter((entry) => entry !== option),
                )
              }
            />
            {option}
          </label>
        ))}
        {value.length ? (
          <button type="button" className="jira-multiselect-clear" onClick={() => onChange([])}>
            Clear
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Drag or arrow-key resizer between the terminal and the docked panel, like
 * the Inspector's (AC29). Measures the workspace surfaces it sits in.
 */
function JiraPanelResizer({
  dock,
  size,
}: {
  dock: "right" | "bottom";
  size: number;
}) {
  const frame = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  const bounds = (element: HTMLElement) =>
    element.parentElement?.getBoundingClientRect() ?? { width: 0, height: 0 };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const { width, height } = bounds(event.currentTarget);
    const startX = event.clientX;
    const startY = event.clientY;
    const startSize = clampJiraDockSize(dock, size, width, height);
    let finalSize = startSize;
    const onMove = (move: PointerEvent) => {
      finalSize = clampJiraDockSize(
        dock,
        startSize +
          (dock === "right" ? startX - move.clientX : startY - move.clientY),
        width,
        height,
      );
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        setJiraDockSize(finalSize);
      });
    };
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
      setJiraDockSize(finalSize, true);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const increase = dock === "right" ? event.key === "ArrowLeft" : event.key === "ArrowUp";
    const decrease = dock === "right" ? event.key === "ArrowRight" : event.key === "ArrowDown";
    if (!increase && !decrease) return;
    event.preventDefault();
    const { width, height } = bounds(event.currentTarget);
    setJiraDockSize(
      clampJiraDockSize(
        dock,
        clampJiraDockSize(dock, size, width, height) +
          (increase ? JIRA_DOCK_KEYBOARD_STEP : -JIRA_DOCK_KEYBOARD_STEP),
        width,
        height,
      ),
      true,
    );
  };

  return (
    <div
      className={`jira-panel-resizer jira-panel-resizer-${dock}`}
      role="separator"
      aria-label={`Resize ${dock} Jira issues`}
      aria-orientation={dock === "right" ? "vertical" : "horizontal"}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}

/** Jira issues panel docked beside the terminal (AC28–AC42). */
export function JiraIssuesPanel() {
  const { jira, tasks, jiraPanelExpanded, jiraDock } = useIssueTrackers();
  const dockSize = jiraDockSize(jiraDock);
  // Seed once per site or default change, not on every config push (AC32).
  const siteUrl = jira?.site_url ?? null;
  const defaultProject = jira?.default_project ?? null;
  const defaultJql = jira?.default_jql ?? "";
  const seeded = useMemo(
    () =>
      siteUrl
        ? initialJiraQuery({ default_project: defaultProject, default_jql: defaultJql })
        : null,
    [siteUrl, defaultProject, defaultJql],
  );
  const [filters, setFilters] = useState<JiraFilters>(
    seeded?.mode === "filters" ? seeded.filters : { assignee: "any" },
  );
  const [jqlMode, setJqlMode] = useState(seeded?.mode === "jql");
  const [jqlDraft, setJqlDraft] = useState(seeded?.mode === "jql" ? seeded.jql : "");
  const [jql, setJql] = useState(seeded?.mode === "jql" ? seeded.jql : "");
  const [text, setText] = useState("");
  const [page, setPage] = useState<PageState>(firstPage);
  const [result, setResult] = useState<JiraSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<{ key: string; name: string }[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [views, setViews] = useState<JiraSavedView[]>([]);
  const [naming, setNaming] = useState(false);
  const request = useRef(0);

  useEffect(() => {
    if (!seeded) return;
    setPage(firstPage);
    if (seeded.mode === "filters") {
      setFilters(seeded.filters);
      setJqlMode(false);
    } else {
      setJqlMode(true);
      setJqlDraft(seeded.jql);
      setJql(seeded.jql);
    }
  }, [seeded]);

  useEffect(() => {
    void callJira<{ projects: { key: string; name: string }[] }>("projects")
      .then((value) => setProjects(value.projects))
      .catch(() => undefined);
    void loadSavedViews().then(setViews).catch(() => undefined);
  }, [siteUrl]);

  useEffect(() => {
    if (!filters.project) {
      setStatuses([]);
      return;
    }
    let cancelled = false;
    void callJira<{ statuses: string[] }>("statuses", { project: filters.project })
      .then((value) => {
        if (!cancelled) setStatuses(value.statuses);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [filters.project]);

  // Debounce typed search into the structured filters.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilters((current) =>
        (current.text ?? "") === text.trim()
          ? current
          : { ...current, text: text.trim() || undefined },
      );
      setPage(firstPage);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [text]);

  const load = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const value = await callJira<JiraSearchResult>("search", {
        ...(jqlMode ? { jql } : { filters }),
        page_token: page.tokens[page.index] ?? undefined,
      });
      if (id === request.current) setResult(value);
    } catch (cause) {
      // Keep the filters and the last results; show the error inline (AC42).
      if (id === request.current) setError((cause as Error).message);
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [filters, jql, jqlMode, page]);

  useEffect(() => {
    if (jqlMode && !jql.trim()) return;
    void load();
  }, [load, jqlMode, jql]);

  const patchFilters = (patch: Partial<JiraFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(firstPage);
  };

  const typeOptions = useMemo(
    () => [
      ...new Set([
        ...COMMON_TYPES,
        ...(result?.issues.map((issue) => issue.type).filter(Boolean) ?? []),
      ]),
    ],
    [result],
  );
  const statusOptions = useMemo(
    () => [
      ...new Set([
        ...statuses,
        ...(result?.issues.map((issue) => issue.status).filter(Boolean) ?? []),
        ...(filters.statuses ?? []),
      ]),
    ],
    [statuses, result, filters.statuses],
  );

  const sort = filters.sort ?? { field: "updated" as const, dir: "desc" as const };
  const issues = result?.issues ?? [];
  const siteName = jiraSiteName(jira?.site_url);

  const applyView = (view: JiraSavedView) => {
    setPage(firstPage);
    if (view.jql !== undefined) {
      setJqlMode(true);
      setJqlDraft(view.jql);
      setJql(view.jql);
    } else {
      setJqlMode(false);
      setFilters(view.filters ?? {});
      setText(view.filters?.text ?? "");
    }
  };

  const saveViews = async (next: JiraSavedView[]) => {
    const previous = views;
    setViews(next);
    try {
      await storeSavedViews(next);
    } catch (cause) {
      setViews(previous);
      setError((cause as Error).message);
    }
  };

  return (
    <>
      {!jiraPanelExpanded ? (
        <JiraPanelResizer dock={jiraDock.dock} size={dockSize} />
      ) : null}
      <aside
        className={`jira-panel jira-panel-dock-${jiraDock.dock} ${jiraPanelExpanded ? "is-expanded" : ""}`}
        aria-label="Jira issues"
        style={
          jiraPanelExpanded
            ? undefined
            : jiraDock.dock === "right"
              ? { width: dockSize }
              : { height: dockSize }
        }
      >
        <div className="jira-panel-head">
          <span className="jira-panel-mark" aria-hidden="true">
            J
          </span>
          <h2>Jira issues</h2>
          {siteName ? <span className="jira-panel-site">· {siteName}</span> : null}
          <span className="jira-panel-spacer" />
          <span className="jira-panel-count" aria-live="polite">
            {loading ? "Loading..." : `${issues.length} issues`}
          </span>
          <button
            type="button"
            className="jira-icon-button"
            aria-label="Refresh issues"
            title="Refresh issues"
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`jira-jql-toggle ${jqlMode ? "is-active" : ""}`}
            aria-pressed={jqlMode}
            title={jqlMode ? "Use filters" : "Write raw JQL"}
            onClick={() => {
              setPage(firstPage);
              if (!jqlMode) setJqlDraft(result?.jql ?? jql);
              setJqlMode(!jqlMode);
            }}
          >
            <Code size={13} aria-hidden="true" /> JQL
          </button>
          {!jiraPanelExpanded ? (
            <button
              type="button"
              className="jira-icon-button"
              title={jiraDock.dock === "right" ? "Dock at bottom" : "Dock at right"}
              aria-label={
                jiraDock.dock === "right"
                  ? "Dock Jira issues at bottom"
                  : "Dock Jira issues at right"
              }
              onClick={() =>
                setJiraDock(jiraDock.dock === "right" ? "bottom" : "right")
              }
            >
              {jiraDock.dock === "right" ? (
                <PanelBottom size={14} aria-hidden="true" />
              ) : (
                <PanelRight size={14} aria-hidden="true" />
              )}
            </button>
          ) : null}
          <button
            type="button"
            className="jira-icon-button"
            aria-label={jiraPanelExpanded ? "Dock Jira issues" : "Expand Jira issues"}
            title={jiraPanelExpanded ? "Dock beside the terminal" : "Pop out to fill the workspace"}
            onClick={() => setJiraPanelExpanded(!jiraPanelExpanded)}
          >
            {jiraPanelExpanded ? (
              <Minimize2 size={14} aria-hidden="true" />
            ) : (
              <Maximize2 size={14} aria-hidden="true" />
            )}
          </button>
          <CloseButton label="Close Jira issues" onClick={() => setJiraPanelOpen(false)} />
        </div>

        {jqlMode ? (
          <form
            className="jira-jql-editor"
            onSubmit={(event) => {
              event.preventDefault();
              setPage(firstPage);
              setJql(jqlDraft.trim());
            }}
          >
            <textarea
              aria-label="JQL query"
              rows={2}
              spellCheck={false}
              value={jqlDraft}
              placeholder='project = "SDS" AND status = "In Progress"'
              onChange={(event) => setJqlDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  setPage(firstPage);
                  setJql(jqlDraft.trim());
                }
              }}
            />
            <button type="submit" disabled={!jqlDraft.trim()}>
              Run
            </button>
          </form>
        ) : null}

        <div className="jira-filters" aria-disabled={jqlMode}>
          <label className="jira-search">
            <Search size={13} aria-hidden="true" />
            <input
              aria-label="Search key or text"
              placeholder="Search key or text..."
              value={text}
              disabled={jqlMode}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <ThemedSelect
            className="jira-filter-select"
            aria-label="Project"
            value={filters.project ?? ""}
            disabled={jqlMode}
            options={[
              { value: "", label: "All projects" },
              ...projects.map((project) => ({
                value: project.key,
                label: project.key,
                detail: project.name,
                keywords: [project.name],
              })),
            ]}
            searchPlaceholder="Search projects"
            emptyText="No projects"
            onChange={(value) =>
              patchFilters({ project: value || undefined, statuses: undefined })
            }
          />
          <MultiSelect
            label="Type"
            options={typeOptions}
            value={filters.types ?? []}
            disabled={jqlMode}
            onChange={(types) => patchFilters({ types: types.length ? types : undefined })}
          />
          <MultiSelect
            label="Status"
            options={statusOptions}
            value={filters.statuses ?? []}
            disabled={jqlMode}
            onChange={(value) =>
              patchFilters({ statuses: value.length ? value : undefined })
            }
          />
          <div className={`jira-assignee ${filters.assignee && filters.assignee !== "any" ? "is-set" : ""}`}>
            <ThemedSelect
              className="jira-filter-select"
              aria-label="Assignee"
              value={filters.assignee ?? "any"}
              disabled={jqlMode}
              options={[
                { value: "me", label: "Assignee: Me" },
                { value: "unassigned", label: "Assignee: Unassigned" },
                { value: "any", label: "Assignee: Anyone" },
              ]}
              onChange={(value) =>
                patchFilters({ assignee: value as JiraFilters["assignee"] })
              }
            />
            {filters.assignee && filters.assignee !== "any" && !jqlMode ? (
              <button
                type="button"
                className="jira-filter-clear"
                aria-label="Clear assignee filter"
                onClick={() => patchFilters({ assignee: "any" })}
              >
                ×
              </button>
            ) : null}
          </div>
          <ThemedSelect
            className="jira-filter-select"
            aria-label="Sort by"
            icon={<ArrowDownWideNarrow size={13} aria-hidden="true" />}
            value={sort.field}
            disabled={jqlMode}
            options={Object.entries(SORT_LABELS).map(([value, label]) => ({
              value,
              label,
            }))}
            onChange={(value) =>
              patchFilters({ sort: { ...sort, field: value as JiraSortField } })
            }
          />
          <button
            type="button"
            className="jira-filter"
            disabled={jqlMode}
            aria-label={`Sort ${sort.dir === "desc" ? "descending" : "ascending"}`}
            title="Toggle sort direction"
            onClick={() =>
              patchFilters({
                sort: { ...sort, dir: sort.dir === "desc" ? "asc" : "desc" },
              })
            }
          >
            {sort.dir === "desc" ? "↓" : "↑"}
          </button>
          <Popover>
            <PopoverTrigger asChild>
              <button type="button" className="jira-filter" aria-label="Saved views">
                <Star size={13} aria-hidden="true" /> Views
                {views.length ? <strong>{views.length}</strong> : null}
              </button>
            </PopoverTrigger>
            <PopoverContent className="jira-views" align="end" aria-label="Saved views">
              <button
                type="button"
                className="jira-views-save"
                onClick={() => setNaming(true)}
              >
                <Plus size={13} aria-hidden="true" /> Save view
              </button>
              {views.length === 0 ? (
                <p className="jira-multiselect-empty">No saved views yet.</p>
              ) : null}
              {views.map((view) => (
                <div key={view.id} className="jira-view-row">
                  <button type="button" onClick={() => applyView(view)}>
                    {view.name}
                    <small>{view.jql !== undefined ? "JQL" : "Filters"}</small>
                  </button>
                  <button
                    type="button"
                    className="jira-icon-button"
                    aria-label={`Delete view ${view.name}`}
                    onClick={() => void saveViews(removeSavedView(views, view.id))}
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </PopoverContent>
          </Popover>
        </div>

        {error ? (
          <div className="jira-panel-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => void load()}>
              Retry
            </button>
            {isJiraAuthError(error) ? (
              <button type="button" onClick={requestJiraSettings}>
                Open Jira settings
              </button>
            ) : null}
          </div>
        ) : null}

        <ul className="jira-issue-list" aria-busy={loading}>
          {!loading && !error && issues.length === 0 ? (
            <li className="jira-issue-empty">No issues match.</li>
          ) : null}
          {issues.map((issue) => (
            <IssueRow key={issue.key} issue={issue} linked={openTasksForIssue(tasks, issue.key)} />
          ))}
        </ul>

        <div className="jira-panel-footer">
          <span>{pageRange(page.index, issues.length)}</span>
          <span className="jira-panel-spacer" />
          <button
            type="button"
            disabled={page.index === 0 || loading}
            onClick={() => setPage(previousPage(page))}
          >
            <ChevronLeft size={13} aria-hidden="true" /> Prev
          </button>
          <span>Page {page.index + 1}</span>
          <button
            type="button"
            disabled={!result?.next_page_token || loading}
            onClick={() =>
              result?.next_page_token &&
              setPage(nextPage(page, result.next_page_token))
            }
          >
            Next <ChevronRight size={13} aria-hidden="true" />
          </button>
        </div>

        <TextInputDialog
          open={naming}
          title="Save view"
          label="View name"
          placeholder="My open bugs"
          submitLabel="Save"
          onClose={() => setNaming(false)}
          onSubmit={(name) => {
            setNaming(false);
            try {
              void saveViews(
                addSavedView(
                  views,
                  name,
                  jqlMode ? { jql: jql || jqlDraft } : { filters },
                ),
              );
            } catch (cause) {
              setError((cause as Error).message);
            }
          }}
        />
      </aside>
    </>
  );
}

function IssueRow({ issue, linked }: { issue: JiraIssue; linked: ReturnType<typeof openTasksForIssue> }) {
  const latest = linked[0];
  return (
    <li className={`jira-issue ${latest ? "is-linked" : ""}`}>
      <div className="jira-issue-main">
        <div className="jira-issue-meta">
          <code>{issue.key}</code>
          <span data-type={issue.type.toLowerCase()}>{issue.type}</span>
          {issue.priority ? <span>· {issue.priority}</span> : null}
          {latest ? (
            <span className="jira-issue-task-badge">
              <SquareCheck size={11} aria-hidden="true" />
              {linked.length} task · {AGENT_TASK_STATUS_LABELS[latest.status].toLowerCase()}
            </span>
          ) : null}
        </div>
        <strong className="jira-issue-summary">{issue.summary}</strong>
        <div className="jira-issue-meta">
          <span className="jira-status-pill" data-category={issue.status_category}>
            {issue.status}
          </span>
          {issue.assignee ? (
            <span className="jira-avatar" title={issue.assignee.name}>
              {issue.assignee.initials}
            </span>
          ) : null}
          {issue.updated_at ? <span>updated {relativeAge(issue.updated_at)}</span> : null}
        </div>
      </div>
      <div className="jira-issue-actions">
        <a
          className="jira-icon-button"
          href={issue.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${issue.key} in Jira`}
          title="Open in Jira"
        >
          <ArrowUpRight size={14} aria-hidden="true" />
        </a>
        {latest ? (
          <button type="button" onClick={() => revealTask(latest.id)}>
            Open task
          </button>
        ) : (
          <button
            type="button"
            className="jira-add-task"
            onClick={() => openNewTask({ issue, mode: "jira" })}
          >
            <Plus size={13} aria-hidden="true" /> Task
          </button>
        )}
      </div>
    </li>
  );
}
