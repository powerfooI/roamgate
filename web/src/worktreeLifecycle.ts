import type {
  ExistingWorktree,
  GitStatusSummary,
  Workspace,
  WorktreeList,
} from "./types";

export interface WorktreeLifecycleRow {
  worktree: ExistingWorktree;
  workspace?: Workspace;
  gitStatus?: GitStatusSummary;
}

export type WorktreeHookName = "setup" | "opened" | "teardown" | "removed";

export type WorktreeHookInfo = {
  key: string | null;
  enabled: boolean;
  paseo_path?: string | null;
  hooks?: Partial<Record<WorktreeHookName, string>>;
  error?: string;
};

export type AutoSyncStatus = "updated" | "up_to_date" | "skipped" | "failed";

export type WorkspaceAutoSyncInfo = {
  workspace_id: string;
  enabled: boolean;
  interval_minutes: number;
  last_run_at?: string;
  last_status?: AutoSyncStatus;
  last_message?: string;
  running: boolean;
};

type LifecycleActionResult = {
  skipped_remove?: boolean;
  setup_hook?: { status?: string; error?: string; stderr?: string };
  opened_hook?: { status?: string; error?: string; stderr?: string };
  before_remove_hook?: { status?: string; error?: string; stderr?: string };
  removed_hook?: { status?: string; error?: string; stderr?: string };
  cleanup?: { warning?: string };
};

function normalizedCheckoutPath(path: string): string {
  if (path === "/") return path;
  return path.replace(/\/+$/, "");
}

export function lifecycleWorktreeTitle(worktree: ExistingWorktree): string {
  if (worktree.branch) return worktree.branch;
  if (worktree.is_detached) return "Detached HEAD";
  if (worktree.is_bare) return "Bare repository";
  return worktree.label || worktree.path;
}

export function lifecycleGitSummary(status?: GitStatusSummary): string {
  if (!status) return "Open this checkout to load Git status and use Git pull.";
  if (status.error) return `Git status unavailable: ${status.error}`;
  const changed = lifecycleGitChangeCount(status);
  const parts = [
    changed ? `${changed} changed` : "No local changes",
    status.ahead ? `${status.ahead} ahead` : null,
    status.behind ? `${status.behind} behind` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

export function lifecycleOpenedWorkspaceId(
  result: unknown,
): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const workspace = (result as { workspace?: unknown }).workspace;
  if (!workspace || typeof workspace !== "object") return undefined;
  const workspaceId = (workspace as { workspace_id?: unknown }).workspace_id;
  return typeof workspaceId === "string" && workspaceId
    ? workspaceId
    : undefined;
}

export function lifecycleRemovalSkipped(result: unknown): boolean {
  return Boolean(
    result &&
      typeof result === "object" &&
      "skipped_remove" in result &&
      (result as { skipped_remove?: unknown }).skipped_remove,
  );
}

export async function removeTemporaryWorkspaceSafely<T>({
  workspaceId,
  temporary,
  remove,
  close,
}: {
  workspaceId: string;
  temporary: boolean;
  remove: () => Promise<T>;
  close: (workspaceId: string) => Promise<unknown>;
}): Promise<T> {
  let result: T;
  try {
    result = await remove();
  } catch (error) {
    if (temporary) {
      try {
        await close(workspaceId);
      } catch (cleanupError) {
        const message = error instanceof Error ? error.message : String(error);
        const cleanupMessage =
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError);
        throw new Error(
          `${message}\nTemporary workspace cleanup failed: ${cleanupMessage}`,
          { cause: cleanupError },
        );
      }
    }
    throw error;
  }

  const incomplete = result === undefined;
  if (temporary && (incomplete || lifecycleRemovalSkipped(result))) {
    await close(workspaceId);
  }
  if (incomplete) {
    throw new Error("Worktree removal did not complete.");
  }
  return result;
}

export function lifecycleAutoSyncLabel(info?: WorkspaceAutoSyncInfo): string {
  if (!info?.enabled) return "Default branch auto-sync off";
  if (info.running) return "Syncing origin's default branch";
  switch (info.last_status) {
    case "updated":
      return "Synced with origin's default branch";
    case "up_to_date":
      return "Up to date with origin's default branch";
    case "skipped":
      return "Last sync skipped";
    case "failed":
      return "Last sync failed";
    default:
      return `Sync origin's default branch every ${info.interval_minutes} min`;
  }
}

export function lifecycleActionError(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const value = result as LifecycleActionResult;
  const failedHook = [
    value.setup_hook,
    value.opened_hook,
    value.before_remove_hook,
    value.removed_hook,
  ].find((hook) => hook?.status === "failed");
  if (failedHook) {
    return failedHook.error || failedHook.stderr || "Repository hook failed";
  }
  if (value.skipped_remove) {
    return "Removal was stopped before deleting the checkout.";
  }
  return undefined;
}

export function lifecycleActionWarning(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  return (result as LifecycleActionResult).cleanup?.warning;
}

function workspaceForCheckout(
  workspaces: Workspace[],
  repoKey: string,
  path: string,
): Workspace | undefined {
  const normalizedPath = normalizedCheckoutPath(path);
  return workspaces
    .filter(
      (workspace) =>
        workspace.worktree?.repo_key === repoKey &&
        normalizedCheckoutPath(workspace.worktree.checkout_path) ===
          normalizedPath,
    )
    .sort(
      (a, b) => Number(b.focused) - Number(a.focused) || a.number - b.number,
    )[0];
}

/**
 * Joins Herdr's repository worktree inventory with currently open workspaces.
 * The inventory owns checkout existence; workspace data contributes live GUI
 * identity and git status. Open workspaces missing from a stale inventory are
 * retained so actions never disappear during a refresh race.
 */
export function buildWorktreeLifecycleRows(
  list: WorktreeList,
  workspaces: Workspace[],
): WorktreeLifecycleRow[] {
  const rowsByPath = new Map<string, WorktreeLifecycleRow>();

  for (const worktree of list.worktrees) {
    const path = normalizedCheckoutPath(worktree.path);
    const workspace = workspaceForCheckout(
      workspaces,
      list.source.repo_key,
      path,
    );
    rowsByPath.set(path, {
      worktree: {
        ...worktree,
        path,
        open_workspace_id:
          workspace?.workspace_id ?? worktree.open_workspace_id,
      },
      workspace,
      gitStatus: workspace?.worktree?.git_status,
    });
  }

  for (const workspace of workspaces) {
    const info = workspace.worktree;
    if (!info || info.repo_key !== list.source.repo_key) continue;
    const path = normalizedCheckoutPath(info.checkout_path);
    if (rowsByPath.has(path)) continue;
    rowsByPath.set(path, {
      worktree: {
        path,
        branch: info.git_status?.branch,
        is_bare: false,
        is_detached: !info.git_status?.branch,
        is_prunable: false,
        is_linked_worktree: info.is_linked_worktree,
        open_workspace_id: workspace.workspace_id,
        label: workspace.label || path.split("/").filter(Boolean).pop() || path,
      },
      workspace,
      gitStatus: info.git_status,
    });
  }

  return [...rowsByPath.values()].sort((a, b) => {
    if (a.worktree.is_linked_worktree !== b.worktree.is_linked_worktree) {
      return a.worktree.is_linked_worktree ? 1 : -1;
    }
    return (
      lifecycleWorktreeTitle(a.worktree).localeCompare(
        lifecycleWorktreeTitle(b.worktree),
      ) || a.worktree.path.localeCompare(b.worktree.path)
    );
  });
}

export function lifecycleGitChangeCount(status?: GitStatusSummary): number {
  if (!status) return 0;
  return status.staged + status.unstaged + status.untracked + status.conflicted;
}
