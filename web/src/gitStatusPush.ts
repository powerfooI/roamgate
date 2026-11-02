import type { GitStatusSummary, Workspace } from "./types";

/** Statuses keyed by checkout path, from a `workspace.git_status` push. */
export type GitStatusPush = Map<string, GitStatusSummary>;

export function parseGitStatusPush(data: unknown): GitStatusPush | null {
  const statuses = (data as { statuses?: unknown } | null)?.statuses;
  if (!Array.isArray(statuses)) return null;
  const push: GitStatusPush = new Map();
  for (const entry of statuses) {
    const record = entry as {
      checkout_path?: unknown;
      git_status?: unknown;
    } | null;
    if (
      typeof record?.checkout_path === "string" &&
      record.git_status &&
      typeof record.git_status === "object"
    ) {
      push.set(record.checkout_path, record.git_status as GitStatusSummary);
    }
  }
  return push;
}

/** Returns `workspaces` itself when the push changes nothing. */
export function withGitStatuses(
  workspaces: Workspace[],
  push: GitStatusPush,
): Workspace[] {
  let changed = false;
  const next = workspaces.map((workspace) => {
    const worktree = workspace.worktree;
    const status = worktree && push.get(worktree.checkout_path);
    if (!worktree || !status || worktree.git_status === status) {
      return workspace;
    }
    changed = true;
    return { ...workspace, worktree: { ...worktree, git_status: status } };
  });
  return changed ? next : workspaces;
}
