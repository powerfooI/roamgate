import { ChevronDown, GitFork } from "lucide-react";
import { useId, useState } from "react";
import type { Workspace } from "../types";

/** Keep checkout context available without spending three lines on mobile history. */
export function WorkspaceInspectorIdentity({
  workspace,
  collapsible,
}: {
  workspace?: Workspace;
  collapsible: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const repo =
    workspace?.worktree?.repo_name || workspace?.label || "Workspace";
  const checkout = workspace
    ? workspace.worktree?.git_status?.branch ||
      workspace.worktree?.repo_name ||
      workspace.label ||
      workspace.workspace_id
    : "Unavailable checkout";
  const path = workspace?.worktree?.checkout_path ?? workspace?.cwd;

  return (
    <div className="workspace-inspector-identity">
      {collapsible ? (
        <button
          type="button"
          className="workspace-inspector-identity-toggle"
          aria-expanded={expanded}
          aria-controls={detailsId}
          aria-label={`${expanded ? "Hide" : "Show"} worktree information for ${repo} / ${checkout}`}
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronDown size={14} aria-hidden="true" />
          <span>
            {repo} / {checkout}
          </span>
        </button>
      ) : null}
      <div
        id={detailsId}
        className="workspace-inspector-identity-details"
        hidden={collapsible && !expanded}
      >
        <span className="workspace-inspector-repo">{repo}</span>
        <span className="workspace-inspector-checkout">
          {checkout}
          {workspace?.worktree?.is_linked_worktree ? (
            <span className="workspace-inspector-wt" title="Linked worktree">
              <GitFork size={11} aria-hidden="true" /> Worktree
            </span>
          ) : null}
        </span>
        {path ? (
          <code className="workspace-inspector-path" title={path}>
            {path}
          </code>
        ) : null}
      </div>
    </div>
  );
}
