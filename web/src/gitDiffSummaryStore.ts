import { useSyncExternalStore } from "react";
import type { ConnectionClient } from "./api";
import type { GitDiffSummary } from "./types";
import { connectionClientScopeKey } from "./useConnectionClient";

export type GitDiffSummaryMode = "working" | "branch-main" | "last-step";

export type GitDiffSummaryState = {
  summary: GitDiffSummary | null;
  loading: boolean;
  error: string | null;
  revision: number;
};

const EMPTY_STATE: GitDiffSummaryState = {
  summary: null,
  loading: false,
  error: null,
  revision: 0,
};

const states = new Map<string, GitDiffSummaryState>();
const listeners = new Map<string, Set<() => void>>();
const requests = new Map<string, Promise<GitDiffSummary>>();
const trailingRequests = new Map<string, Promise<GitDiffSummary>>();
const activeTokens = new Map<string, symbol>();
const MAX_RETAINED_SUMMARIES = 24;

export function gitDiffSummaryKey(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId: string,
  mode: GitDiffSummaryMode,
  resourceKey = workspaceId,
  baseBranch?: string,
) {
  return connectionClientScopeKey(
    client,
    "git-diff-summary",
    resourceKey,
    workspaceId,
    mode,
    mode === "branch-main" ? (baseBranch ?? "automatic") : "automatic",
  );
}

function stateForKey(key: string | null): GitDiffSummaryState {
  return key ? (states.get(key) ?? EMPTY_STATE) : EMPTY_STATE;
}

function notify(key: string) {
  for (const listener of listeners.get(key) ?? []) listener();
}

function pruneStates(preserveKey?: string) {
  while (states.size > MAX_RETAINED_SUMMARIES) {
    const candidate = Array.from(states.keys()).find(
      (key) => key !== preserveKey && !listeners.has(key) && !requests.has(key),
    );
    if (!candidate) return;
    states.delete(candidate);
    activeTokens.delete(candidate);
  }
}

function publish(key: string, patch: Partial<GitDiffSummaryState>) {
  const current = stateForKey(key);
  states.delete(key);
  states.set(key, { ...current, ...patch });
  pruneStates(key);
  notify(key);
}

function keyMatchesResource(
  key: string,
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  resourceKey: string,
) {
  try {
    const parts = JSON.parse(key) as unknown[];
    return (
      parts[0] === client.connectionId &&
      parts[1] === client.generation &&
      parts[2] === "git-diff-summary" &&
      parts[3] === resourceKey
    );
  } catch {
    return false;
  }
}

export function retireGitDiffSummary(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId: string,
  mode: GitDiffSummaryMode,
  resourceKey = workspaceId,
  baseBranch?: string,
) {
  const key = gitDiffSummaryKey(
    client,
    workspaceId,
    mode,
    resourceKey,
    baseBranch,
  );
  states.delete(key);
  requests.delete(key);
  trailingRequests.delete(key);
  activeTokens.delete(key);
  notify(key);
}

export function retireGitDiffSummaryResource(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  resourceKey: string,
) {
  const keys = new Set([
    ...states.keys(),
    ...requests.keys(),
    ...trailingRequests.keys(),
    ...activeTokens.keys(),
  ]);
  for (const key of keys) {
    if (!keyMatchesResource(key, client, resourceKey)) continue;
    states.delete(key);
    requests.delete(key);
    trailingRequests.delete(key);
    activeTokens.delete(key);
    notify(key);
  }
}

export function subscribeGitDiffSummary(
  key: string | null,
  listener: () => void,
) {
  if (!key) return () => undefined;
  const scoped = listeners.get(key) ?? new Set<() => void>();
  scoped.add(listener);
  listeners.set(key, scoped);
  return () => {
    scoped.delete(listener);
    if (!scoped.size) listeners.delete(key);
  };
}

export function readGitDiffSummary(key: string | null) {
  return stateForKey(key);
}

export function useGitDiffSummaryState(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId: string | undefined,
  mode: GitDiffSummaryMode,
  resourceKey = workspaceId,
  baseBranch?: string,
) {
  const key = workspaceId
    ? gitDiffSummaryKey(client, workspaceId, mode, resourceKey, baseBranch)
    : null;
  return useSyncExternalStore(
    (listener) => subscribeGitDiffSummary(key, listener),
    () => readGitDiffSummary(key),
    () => readGitDiffSummary(key),
  );
}

export function refreshGitDiffSummary(
  client: ConnectionClient,
  workspaceId: string,
  mode: GitDiffSummaryMode,
  resourceKey = workspaceId,
  options: { afterCurrent?: boolean; baseBranch?: string } = {},
): Promise<GitDiffSummary> {
  const baseBranch = mode === "branch-main" ? options.baseBranch : undefined;
  const key = gitDiffSummaryKey(
    client,
    workspaceId,
    mode,
    resourceKey,
    baseBranch,
  );
  const running = requests.get(key);
  if (running && options.afterCurrent) {
    const queued = trailingRequests.get(key);
    if (queued) return queued;
    const trailing = running
      .catch(() => undefined)
      .then(() => {
        if (trailingRequests.get(key) !== trailing) {
          throw new Error("queued diff summary request retired");
        }
        if (!client.isCurrent()) {
          throw new Error(
            "connection changed before queued diff summary request",
          );
        }
        return refreshGitDiffSummary(client, workspaceId, mode, resourceKey, {
          baseBranch,
        });
      })
      .finally(() => {
        if (trailingRequests.get(key) === trailing) {
          trailingRequests.delete(key);
        }
      });
    trailingRequests.set(key, trailing);
    return trailing;
  }
  if (running) return running;

  const revision = stateForKey(key).revision + 1;
  const token = Symbol(key);
  activeTokens.set(key, token);
  publish(key, { loading: true, error: null, revision });
  const task = (
    client.call("git.diff_summary", {
      workspace_id: workspaceId,
      mode,
      ...(baseBranch ? { base_branch: baseBranch } : {}),
    }) as Promise<GitDiffSummary>
  )
    .then((summary) => {
      if (!client.isCurrent()) {
        throw new Error("connection changed during diff summary request");
      }
      if (activeTokens.get(key) === token) {
        publish(key, { summary, loading: false, error: null });
      }
      return summary;
    })
    .catch((error) => {
      if (client.isCurrent() && activeTokens.get(key) === token) {
        publish(key, {
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    })
    .finally(() => {
      if (requests.get(key) === task) requests.delete(key);
      pruneStates();
    });
  requests.set(key, task);
  return task;
}
