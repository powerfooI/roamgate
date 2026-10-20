import type { Workspace } from "./types";
import type { PullRequestSummary } from "../../shared/pullRequest";

export function workspacePullRequest(status?: PullRequestSummary) {
  const request = status?.state === "ready" ? status.request : undefined;
  if (!request || !status?.provider) return null;
  const state =
    request.state === "merged" || request.state === "closed"
      ? request.state
      : request.state === "open" || request.state === "opened"
        ? request.draft
          ? "draft"
          : "open"
        : null;
  if (!state) return null;
  const label = {
    open: "Open",
    draft: "Draft",
    merged: "Merged",
    closed: "Closed without merge",
  }[state];
  const github = status.provider === "github";
  return {
    request,
    state,
    id: `${github ? "#" : "!"}${request.number}`,
    title: `${github ? "PR #" : "MR !"}${request.number}: ${label}\n${request.title}`,
    openLabel: github ? "Open PR on GitHub" : "Open MR on GitLab",
  } as const;
}

export function workspaceDisplayName(workspace: Workspace): string {
  return workspace.label || workspace.workspace_id;
}

export function showWorkspaceBranchBadge(workspace: Workspace): boolean {
  const branch = workspace.worktree?.git_status?.branch;
  if (!branch) return true;
  return !(
    workspace.worktree?.is_linked_worktree === true &&
    workspaceDisplayName(workspace).trim() === branch.trim()
  );
}
