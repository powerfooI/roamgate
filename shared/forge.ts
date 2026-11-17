/**
 * Merge requests (GitLab) and pull requests (GitHub) as the agent chats show
 * them: chips for references in messages, the session's own in the header,
 * and the list of every one the conversation touched. Read only, through
 * the user's glab and gh logins on the checkout's host.
 */

export type ForgeProvider = "gitlab" | "github";

/** A repository on a forge: `group/sub/project` or `owner/repo`. */
export type ForgeProject = {
  provider: ForgeProvider;
  host: string;
  project: string;
};

/** One merge request or pull request. */
export type ForgeRef = ForgeProject & { number: number };

/** What its CI says, folded to the states a chip shows. */
export type ForgePipelineStatus =
  | "running"
  | "pending"
  | "success"
  | "failed"
  | "canceled"
  | "skipped"
  | "manual";

export type ForgePipeline = {
  status: ForgePipelineStatus;
  /** Failed jobs (GitLab) or checks (GitHub), a few at most. */
  failed: { name: string; stage?: string; allowFailure?: boolean }[];
};

export type ForgeRequestState = "open" | "merged" | "closed" | "locked";

export type ForgeRequest = {
  /** Its own https web page, as the forge answered it. */
  url: string;
  /** The canonical project path, as the forge answered it. */
  project: string;
  title: string;
  state: ForgeRequestState;
  draft: boolean;
  author: string;
  sourceBranch: string;
  targetBranch: string;
  updatedAt: string;
  /** Null: no pipeline (or check) reported. */
  pipeline: ForgePipeline | null;
  /** Null: the forge did not say. */
  approvals: { approved: boolean | null; count: number } | null;
  /** Unresolved threads; null when the forge did not say. */
  unresolved: number | null;
};

export type ForgeStatus = {
  ref: ForgeRef;
  state:
    | "ready"
    /** glab or gh has no login for the host: nothing was asked. */
    | "not_signed_in"
    /** glab or gh is not installed where the checkout is. */
    | "unavailable"
    | "not_found"
    | "error";
  message?: string;
  request?: ForgeRequest;
  fetchedAt: string;
};

/** A repository the session works in, and its branch's request. */
export type ForgeSessionRepo = {
  root: string;
  branch: string;
  /** Where its merge requests live; null for a remote no forge answers. */
  project: ForgeProject | null;
  /** Its branch's open request (GitLab) or latest one (GitHub). */
  request: { url: string; number: number; title: string } | null;
};

export type ForgeSession = {
  /** What `!123` and `#123` mean: the pane's repository's project. */
  defaultProject: ForgeProject | null;
  repos: ForgeSessionRepo[];
  refreshedAt: string;
};

export function forgeRefKey(ref: ForgeRef): string {
  return `${ref.provider}:${ref.host.toLowerCase()}/${ref.project.toLowerCase()}#${ref.number}`;
}

/** `group/project!12` or `owner/repo#12`, as each forge writes it. */
export function forgeRefLabel(ref: ForgeRef, short = false): string {
  const mark = ref.provider === "gitlab" ? "!" : "#";
  return short ? `${mark}${ref.number}` : `${ref.project}${mark}${ref.number}`;
}

/** "MR" on GitLab, "PR" on GitHub. */
export function forgeKind(provider: ForgeProvider): "MR" | "PR" {
  return provider === "gitlab" ? "MR" : "PR";
}

const PROJECT_PATH = /^[\w.-]+(?:\/[\w.-]+)+$/;
const HOST = /^[a-z0-9][a-z0-9.-]*(?::\d+)?$/i;

/**
 * The request a web URL names: GitLab `/-/merge_requests/N` and GitHub
 * `/pull/N`, https only, without credentials. GitHub is github.com or a
 * host whose path has the `owner/repo/pull/N` shape and no `/-/`.
 */
export function parseForgeUrl(value: string): ForgeRef | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.host.toLowerCase();
  if (!HOST.test(host)) return null;
  const path = url.pathname.replace(/\/+$/, "");
  const gitlab = /^\/(.+?)\/-\/merge_requests\/(\d{1,9})(?:\/.*)?$/.exec(path);
  if (gitlab) {
    const project = gitlab[1]!;
    if (!validProject(project)) return null;
    return {
      provider: "gitlab",
      host,
      project,
      number: Number(gitlab[2]),
    };
  }
  const github = /^\/([\w.-]+\/[\w.-]+)\/pull\/(\d{1,9})(?:\/.*)?$/.exec(path);
  if (github && validProject(github[1]!))
    return {
      provider: "github",
      host,
      project: github[1]!,
      number: Number(github[2]),
    };
  return null;
}

export function validProject(project: string): boolean {
  return (
    project.length <= 300 &&
    PROJECT_PATH.test(project) &&
    !project.split("/").some((part) => part === "." || part === "..")
  );
}

export function validHost(host: string): boolean {
  return HOST.test(host) && host.length <= 253;
}

/**
 * Whether a URL the forge answered is the request's own web page: https,
 * on the host asked, no credentials, and naming that request.
 */
export function ownRequestUrl(ref: ForgeRef, value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = parseForgeUrl(value);
  if (
    !parsed ||
    parsed.provider !== ref.provider ||
    parsed.host !== ref.host.toLowerCase() ||
    parsed.number !== ref.number
  )
    return null;
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.href;
  } catch {
    return null;
  }
}
