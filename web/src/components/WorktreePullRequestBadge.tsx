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
  const stale = request ? status?.stale : undefined;
  const text = `${provider}${request ? ` #${request.number}` : ""}: ${label}${stale ? " (last known)" : ""}`;
  return (
    <details className="worktree-review">
      <summary
        className="badge worktree-review-badge"
        data-state={state}
        data-stale={stale ? true : undefined}
      >
        {text}
      </summary>
      <div className="worktree-review-detail">
        {request?.title ?? status?.message ?? label}
        {stale ? (
          <span>
            {stale.failedAt ? (
              <>
                Refresh failed at{" "}
                <time dateTime={stale.failedAt}>
                  {new Date(stale.failedAt).toLocaleString()}
                </time>
                ; showing the last known status.
              </>
            ) : (
              (stale.message ??
              "Showing the last known status while refreshing.")
            )}
          </span>
        ) : null}
        {request ? (
          <a href={request.url} target="_blank" rel="noopener noreferrer">
            Open {provider} #{request.number}
          </a>
        ) : null}
        {status ? (
          <time dateTime={status.refreshedAt}>
            {stale ? "Last successful check" : "Last checked"}:{" "}
            {new Date(status.refreshedAt).toLocaleString()}
          </time>
        ) : null}
      </div>
    </details>
  );
}
