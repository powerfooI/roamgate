import { useEffect, useEffectEvent, useRef, useState } from "react";
import { store, useStoreSelector } from "../store";
import {
  connectionClientScopeKey,
  useConnectionClient,
} from "../useConnectionClient";
import { useWorktreePullRequests } from "../useWorktreePullRequests";
import type { ExistingWorktree, WorktreeList } from "../types";
import { resolveWorktreeOpenSource } from "../worktree";
import { CloseButton } from "./CloseButton";
import { WorktreePullRequestBadge } from "./WorktreePullRequestBadge";
import { focusDialogElement } from "./dialogFocus";
import "./WorktreeOpenDialog.css";

function worktreeTitle(worktree: ExistingWorktree) {
  if (worktree.branch) return worktree.branch;
  if (worktree.is_detached) return "Detached HEAD";
  if (worktree.is_bare) return "Bare repository";
  return worktree.label || worktree.path;
}

function sortWorktrees(a: ExistingWorktree, b: ExistingWorktree) {
  if (a.is_linked_worktree !== b.is_linked_worktree) {
    return a.is_linked_worktree ? 1 : -1;
  }
  return worktreeTitle(a).localeCompare(worktreeTitle(b));
}

type WorktreeListState = {
  scope: string;
  list: WorktreeList | null;
  error: string;
};

export function WorktreeOpenDialog({
  open,
  workspaceId,
  sourceWorkspaceId,
  sourceCwd,
  onClose,
}: {
  open: boolean;
  workspaceId: string | null;
  sourceWorkspaceId?: string | null;
  sourceCwd?: string | null;
  onClose: () => void;
}) {
  const connectionClient = useConnectionClient();
  const workspace = useStoreSelector((state) =>
    state.workspaces.find((entry) => entry.workspace_id === workspaceId),
  );
  const [refresh, setRefresh] = useState(0);
  const scope = connectionClientScopeKey(
    connectionClient,
    workspaceId,
    workspace?.worktree?.repo_key,
    workspace?.cwd,
    workspace?.worktree?.git_status?.branch,
    refresh,
  );
  const [manualTarget, setManualTarget] = useState("");
  const [query, setQuery] = useState("");
  const [listState, setListState] = useState<WorktreeListState | null>(null);
  const [actionError, setActionError] = useState<{
    scope: string;
    message: string;
  } | null>(null);
  const onCloseEvent = useEffectEvent(onClose);
  const searchRef = useRef<HTMLInputElement>(null);
  const manualTargetRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || !workspaceId) return;
    let cancelled = false;
    setManualTarget("");
    setQuery("");
    setActionError(null);
    setListState({ scope, list: null, error: "" });

    connectionClient.call("worktree.list", { workspace_id: workspaceId }).then(
      (result) => {
        if (cancelled || !connectionClient.isCurrent()) return;
        setListState({
          scope,
          list: result as WorktreeList,
          error: "",
        });
      },
      (err) => {
        if (cancelled || !connectionClient.isCurrent()) return;
        setListState({
          scope,
          list: null,
          error: (err as Error).message,
        });
      },
    );

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseEvent();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKey);
    };
  }, [connectionClient, open, workspaceId, scope]);

  const currentListState = listState?.scope === scope ? listState : null;
  const list = currentListState?.list ?? null;
  const reviews = useWorktreePullRequests(
    connectionClient,
    workspaceId,
    open ? list : null,
    refresh,
  );
  const loading = !!open && !!workspaceId && !list && !currentListState?.error;
  const error =
    (actionError?.scope === scope ? actionError.message : "") ||
    currentListState?.error ||
    "";

  useEffect(() => {
    if (!open || !workspaceId || loading) return;
    // Prefer the search field when there are known worktrees; otherwise
    // focus the manual branch/path input so the dialog is ready to type into.
    return focusDialogElement(searchRef.current ?? manualTargetRef.current);
  }, [open, workspaceId, loading, list?.worktrees.length]);

  if (!open || !workspaceId) return null;

  const actionSource = resolveWorktreeOpenSource(
    list,
    sourceWorkspaceId,
    sourceCwd,
  );
  const openTarget = (target: string) => {
    if (!connectionClient.isCurrent()) return undefined;
    if (actionSource?.workspaceId) {
      return store.openWorktree(actionSource.workspaceId, target);
    }
    if (actionSource?.cwd) {
      return store.openWorktreeFromCwd(actionSource.cwd, target);
    }
    setActionError({
      scope,
      message: "Repository source unavailable.",
    });
    return undefined;
  };

  const normalizedQuery = query.trim().toLowerCase();
  const worktrees = [...(list?.worktrees ?? [])]
    .filter((worktree) => {
      if (!normalizedQuery) return true;
      return [
        worktree.branch,
        worktree.label,
        worktree.path,
        worktree.is_linked_worktree ? "worktree" : "main",
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalizedQuery));
    })
    .sort(sortWorktrees);
  const openManual = (e: React.FormEvent) => {
    e.preventDefault();
    const value = manualTarget.trim();
    if (!value) return;
    if (openTarget(value)) onClose();
  };

  const openWorktree = (worktree: ExistingWorktree) => {
    if (worktree.open_workspace_id) {
      store.focusWorkspace(worktree.open_workspace_id);
      onClose();
    } else {
      if (openTarget(worktree.path)) onClose();
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal worktree-open-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Open Worktree"
        onSubmit={openManual}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>Open Worktree</h2>
          <button
            type="button"
            className="ghost"
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            Refresh
          </button>
          <CloseButton onClick={onClose} />
        </div>

        {list ? (
          <div className="modal-meta">
            <span>{list.source.repo_name}</span>
            <code>{list.source.repo_root}</code>
          </div>
        ) : null}

        {loading ? (
          <p className="modal-body-text">Loading worktrees...</p>
        ) : null}
        {error ? <p className="modal-error">{error}</p> : null}

        {list?.worktrees.length ? (
          <label className="form-field worktree-search-field">
            <span>Search</span>
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder="Branch name or checkout path"
            />
          </label>
        ) : null}

        {worktrees.length ? (
          <div className="worktree-list" role="list">
            {worktrees.map((worktree) => (
              <div
                key={worktree.path}
                className="worktree-option"
                role="listitem"
              >
                <button
                  type="button"
                  className="worktree-option-open"
                  onClick={() => openWorktree(worktree)}
                >
                  <span className="worktree-option-main">
                    <span className="worktree-option-title">
                      {worktreeTitle(worktree)}
                    </span>
                    <span className="worktree-option-path">
                      {worktree.path}
                    </span>
                  </span>
                  <span className="worktree-option-tags">
                    {worktree.is_linked_worktree ? (
                      <span className="badge">worktree</span>
                    ) : (
                      <span className="badge">main</span>
                    )}
                    {worktree.is_prunable ? (
                      <span className="badge">prunable</span>
                    ) : null}
                    <span className="badge">
                      {worktree.open_workspace_id ? "Focus" : "Open"}
                    </span>
                  </span>
                </button>
                <WorktreePullRequestBadge status={reviews[worktree.path]} />
              </div>
            ))}
          </div>
        ) : !loading && !error ? (
          <p className="modal-body-text">
            {list?.worktrees.length
              ? "No matching worktrees."
              : "No worktrees found."}
          </p>
        ) : null}

        <label className="form-field">
          <span>Branch or absolute path</span>
          <input
            ref={manualTargetRef}
            value={manualTarget}
            onChange={(e) => setManualTarget(e.currentTarget.value)}
            placeholder="feature/my-branch or /repo/worktree"
            disabled={!actionSource}
          />
        </label>

        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={!manualTarget.trim() || !actionSource}
          >
            Open
          </button>
        </div>
      </form>
    </div>
  );
}
