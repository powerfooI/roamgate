import type {
  PullRequest,
  PullRequestSummary,
  ReviewProvider,
} from "../../shared/pullRequest";
import type { ConnectionSummary } from "./api";
import { roamgateLocalStorage } from "./browserStorage";

export const PULL_REQUEST_CACHE_KEY = "pullRequestSummaries:v1";
const MAX_ENTRIES = 200;

type CachedSummary = { branch: string; status: PullRequestSummary };

export function pullRequestConnectionKey(connection?: ConnectionSummary) {
  if (!connection) return null;
  return JSON.stringify([
    connection.id,
    connection.source,
    connection.type,
    connection.control_socket_path,
    connection.ssh_destination,
    connection.remote_control_socket_path,
    connection.remote_session,
  ]);
}

// Browser storage is untrusted; retain only the fields used by badges and links.
function validSummary(value: unknown): value is PullRequestSummary & {
  request: PullRequest;
  provider: ReviewProvider;
} {
  if (!value || typeof value !== "object") return false;
  const status = value as PullRequestSummary;
  const request = status.request;
  if (
    status.state !== "ready" ||
    !["github", "gitlab"].includes(status.provider ?? "") ||
    typeof status.refreshedAt !== "string" ||
    !Number.isFinite(Date.parse(status.refreshedAt)) ||
    !request ||
    !Number.isSafeInteger(request.number) ||
    request.number <= 0 ||
    typeof request.draft !== "boolean" ||
    !["open", "opened", "closed", "merged"].includes(request.state) ||
    ![
      request.id,
      request.title,
      request.author,
      request.source,
      request.target,
      request.url,
    ].every((field) => typeof field === "string" && field.length <= 2000)
  )
    return false;
  try {
    const url = new URL(request.url);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function readPullRequestCache(): Map<string, CachedSummary> {
  try {
    const raw = roamgateLocalStorage.getItem(PULL_REQUEST_CACHE_KEY);
    if (!raw || raw.length > 2_000_000) return new Map();
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values)) return new Map();
    const entries = new Map<string, CachedSummary>();
    for (const entry of values.slice(-MAX_ENTRIES)) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [key, value] = entry;
      if (
        typeof key !== "string" ||
        key.length > 16_000 ||
        !value ||
        typeof value.branch !== "string" ||
        !value.branch ||
        value.branch === "detached" ||
        !validSummary(value.status)
      )
        continue;
      const { provider, refreshedAt, request } = value.status;
      entries.set(key, {
        branch: value.branch,
        status: {
          state: "ready",
          provider,
          refreshedAt,
          request: {
            id: request.id,
            number: request.number,
            title: request.title,
            author: request.author,
            source: request.source,
            target: request.target,
            state: request.state,
            draft: request.draft,
            url: request.url,
          },
        },
      });
    }
    return entries;
  } catch {
    return new Map();
  }
}

export function writePullRequestCache(
  key: string,
  branch: string | undefined,
  status: PullRequestSummary,
) {
  // A verified rebase may resolve "detached", but that sentinel is not a
  // durable branch identity. Keep the named branch's existing cache instead.
  if (status.state === "ready" && branch === "detached") return;
  const entries = readPullRequestCache();
  entries.delete(key);
  if (branch && branch !== "detached" && validSummary(status))
    entries.set(key, {
      branch,
      status: {
        state: "ready",
        provider: status.provider,
        refreshedAt: status.refreshedAt,
        request: status.request,
      },
    });
  try {
    roamgateLocalStorage.setItem(
      PULL_REQUEST_CACHE_KEY,
      JSON.stringify([...entries].slice(-MAX_ENTRIES)),
    );
  } catch {
    // Memory state still works when browser storage is blocked or full.
  }
}
