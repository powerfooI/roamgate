export type ReviewProvider = "github" | "gitlab";

export type ReviewRemote = {
  name: string;
  host: string;
  repository: string;
};

export type PullRequest = {
  id: string;
  number: number;
  title: string;
  author: string;
  source: string;
  target: string;
  state: string;
  draft: boolean;
  url: string;
};

export type PullRequestStatus = {
  state:
    | "ready"
    | "select_remote"
    | "select_match"
    | "unsupported"
    | "missing_cli"
    | "unauthenticated"
    | "no_match"
    | "detached"
    | "error";
  message?: string;
  root: string;
  branch: string;
  /** The branch was recovered from an in-progress rebase on a detached HEAD. */
  rebasing?: boolean;
  /**
   * A provider or transport failure that cannot disprove an existing link.
   * Errors without this flag, such as a branch change during refresh,
   * invalidate the previous association.
   */
  retryable?: boolean;
  refreshedAt: string;
  remotes: ReviewRemote[];
  remote?: string;
  provider?: ReviewProvider;
  matches?: PullRequest[];
  request?: PullRequest;
  ci?: string;
  review?: string;
};

export type PullRequestSummary = Pick<
  PullRequestStatus,
  "state" | "message" | "refreshedAt" | "provider" | "request" | "retryable"
> & {
  /**
   * The last successful result, awaiting verification or after a failed refresh.
   * `refreshedAt` remains the last successful refresh time.
   */
  stale?: { failedAt?: string; message?: string };
};

export function pullRequestUnavailable(status: PullRequestSummary): boolean {
  return (
    status.retryable === true ||
    status.state === "missing_cli" ||
    status.state === "unauthenticated"
  );
}
