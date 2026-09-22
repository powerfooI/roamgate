import {
  FileDiff,
  Focus as FocusIcon,
  FolderOpen,
  FolderTree,
  GitBranch,
  GitMerge,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { store } from "../store";
import type { InspectorView } from "../workspaceResource";
import {
  lifecycleAutoSyncLabel,
  lifecycleGitChangeCount,
  lifecycleGitSummary,
  lifecycleWorktreeTitle,
  type WorkspaceAutoSyncInfo,
  type WorktreeLifecycleRow as LifecycleRow,
} from "../worktreeLifecycle";

export function WorktreeLifecycleRow({
  row,
  syncInfo,
  operationRunning,
  rowBusy,
  runOperation,
  onFocus,
  onOpen,
  onOpenResource,
  onRemove,
}: {
  row: LifecycleRow;
  syncInfo?: WorkspaceAutoSyncInfo;
  operationRunning: boolean;
  rowBusy: boolean;
  runOperation: (
    key: string,
    label: string,
    action: () => Promise<unknown>,
  ) => void;
  onFocus: (workspaceId: string) => void;
  onOpen: (row: LifecycleRow) => Promise<unknown>;
  onOpenResource: (row: LifecycleRow, view: InspectorView) => Promise<unknown>;
  onRemove: (row: LifecycleRow) => void;
}) {
  const workspace = row.workspace;
  const rowKey = row.worktree.path;
  const title = lifecycleWorktreeTitle(row.worktree);
  const changed = lifecycleGitChangeCount(row.gitStatus);

  return (
    <article className="lifecycle-row" role="listitem">
      <div className="lifecycle-row-main">
        <div className="lifecycle-row-title">
          <GitBranch size={16} />
          <strong>{title}</strong>
          <span className="badge">
            {row.worktree.is_linked_worktree ? "Linked" : "Main"}
          </span>
          <span
            className={`lifecycle-open-state ${workspace ? "is-open" : ""}`}
          >
            {workspace ? "Open" : "Closed"}
          </span>
        </div>
        <code title={row.worktree.path}>{row.worktree.path}</code>
        <div className="lifecycle-row-meta">
          <span className={changed ? "has-changes" : ""}>
            {lifecycleGitSummary(row.gitStatus)}
          </span>
          {workspace ? (
            <span
              className={`lifecycle-sync-status lifecycle-sync-${
                syncInfo?.running
                  ? "running"
                  : (syncInfo?.last_status ?? "idle")
              }`}
              title={syncInfo?.last_message}
            >
              {lifecycleAutoSyncLabel(syncInfo)}
            </span>
          ) : null}
          {row.worktree.is_prunable ? (
            <span className="lifecycle-prunable">Prunable</span>
          ) : null}
        </div>
      </div>

      <div className="lifecycle-row-actions">
        {workspace ? (
          <button
            type="button"
            className="ghost"
            disabled={operationRunning}
            onClick={() => onFocus(workspace.workspace_id)}
          >
            <FocusIcon size={14} />
            Focus
          </button>
        ) : (
          <button
            type="button"
            className="ghost"
            title="Open worktree"
            disabled={operationRunning}
            onClick={() =>
              runOperation(rowKey, "Opening worktree", () => onOpen(row))
            }
          >
            <FolderOpen size={14} />
            Open
          </button>
        )}
        {!workspace && !row.worktree.is_prunable ? (
          <>
            <button
              type="button"
              className="ghost"
              title="Open workspace and browse files"
              disabled={operationRunning}
              onClick={() =>
                runOperation(rowKey, "Opening Files", () =>
                  onOpenResource(row, "files"),
                )
              }
            >
              <FolderTree size={14} />
              Files
            </button>
            <button
              type="button"
              className="ghost"
              title="Open workspace and review changes"
              disabled={operationRunning}
              onClick={() =>
                runOperation(rowKey, "Opening Changes", () =>
                  onOpenResource(row, "changes"),
                )
              }
            >
              <FileDiff size={14} />
              Changes
            </button>
          </>
        ) : null}
        {workspace ? (
          <button
            type="button"
            className="ghost lifecycle-pull-button"
            aria-label={`Pull ${title}`}
            title="Git pull"
            disabled={operationRunning}
            onClick={() =>
              runOperation(rowKey, "Pulling current branch", () =>
                store.gitPullWorkspace(workspace.workspace_id),
              )
            }
          >
            <GitMerge size={14} />
            Pull
          </button>
        ) : null}
        {workspace ? (
          <button
            type="button"
            aria-label={`Auto-sync origin's default branch into ${title}`}
            aria-pressed={syncInfo?.enabled ?? false}
            title={
              syncInfo?.enabled
                ? "Auto sync from origin's default branch is enabled. Click to disable."
                : "Auto sync from origin's default branch into this branch. Click to enable."
            }
            className={`ghost lifecycle-sync-toggle ${
              syncInfo?.enabled ? "is-active" : ""
            }`}
            disabled={!syncInfo || operationRunning}
            onClick={() =>
              runOperation(rowKey, "Updating auto-sync policy", () =>
                store.setWorkspaceAutoSyncEnabled(
                  workspace.workspace_id,
                  !(syncInfo?.enabled ?? false),
                ),
              )
            }
          >
            <RefreshCw size={13} />
            Sync
          </button>
        ) : null}
        {row.worktree.is_linked_worktree && !row.worktree.is_prunable ? (
          <button
            type="button"
            className="ghost lifecycle-remove-button"
            aria-label={`Remove ${title}`}
            title="Remove worktree"
            disabled={operationRunning}
            onClick={() => onRemove(row)}
          >
            {rowBusy ? (
              <span className="hook-loading-mark" />
            ) : (
              <Trash2 size={15} />
            )}
            Remove
          </button>
        ) : null}
      </div>
    </article>
  );
}
