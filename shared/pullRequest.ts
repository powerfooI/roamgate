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
  refreshedAt: string;
  remotes: ReviewRemote[];
  remote?: string;
  provider?: ReviewProvider;
  matches?: PullRequest[];
  request?: PullRequest;
  ci?: string;
  review?: string;
};
