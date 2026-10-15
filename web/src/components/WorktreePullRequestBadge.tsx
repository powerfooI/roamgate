import type { PullRequestSummary } from "../../../shared/pullRequest";
import "./WorktreePullRequestBadge.css";

const labels: Record<PullRequestSummary["state"], string> = {
  ready: "Unknown",
  select_remote: "Select remote",
  select_match: "Multiple matches",
  unsupported: "Unsupported",
  missing_cli: "Missing CLI",
  unauthenticated: "Auth unavailable",
  no_match: "No match",
  detached: "Detached HEAD",
  error: "Unavailable",
};

export function WorktreePullRequestBadge({
  status,
}: {
  status?: PullRequestSummary;
}) {
  const request = status?.state === "ready" ? status.request : undefined;
  const state = request?.state;
  const label =
    state === "merged"
      ? "Merged"
      : state === "closed"
        ? "Closed without merge"
        : state === "open" || state === "opened"
          ? request?.draft
            ? "Draft"
            : "Open"
          : status
            ? labels[status.state]
            : "Loading...";
  const provider = status?.provider
    ? status.provider === "github"
      ? "PR"
      : "MR"
    : "PR/MR";
  const text = `${provider}${request ? ` #${request.number}` : ""}: ${label}`;
  return (
    <details className="worktree-review">
      <summary className="badge worktree-review-badge" data-state={state}>
        {text}
      </summary>
      <div className="worktree-review-detail">
        {request?.title ?? status?.message ?? label}
        {request ? (
          <a href={request.url} target="_blank" rel="noopener noreferrer">
            Open {provider} #{request.number}
          </a>
        ) : null}
        {status ? (
          <time dateTime={status.refreshedAt}>
            Last checked: {new Date(status.refreshedAt).toLocaleString()}
          </time>
        ) : null}
      </div>
    </details>
  );
}
