import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  pullRequestUnavailable,
  type PullRequestSummary,
} from "../../shared/pullRequest";
import type { ConnectionClient } from "./api";
import { useStoreSelector } from "./store";
import {
  pullRequestConnectionKey,
  readPullRequestCache,
  writePullRequestCache,
} from "./pullRequestCache";
import type { Workspace, WorktreeList } from "./types";
import {
  connectionClientScopeKey,
  useConnectionReady,
} from "./useConnectionClient";

type SummaryTarget = {
  id: string;
  /** Changes whenever a previous summary must not be shown for this target. */
  association: string;
  identity: string;
  persistent: boolean;
  branch?: string;
  queryable: boolean;
  params: Record<string, unknown>;
};

type SummaryEntry = {
  association: string;
  identity: string;
  branch?: string;
  status: PullRequestSummary;
  lastGood?: PullRequestSummary;
};

function useCacheScope(client: ConnectionClient) {
  return useStoreSelector((state) =>
    pullRequestConnectionKey(
      state.connections.find(
        (connection) => connection.id === client.connectionId,
      ),
    ),
  );
}

export function useWorktreePullRequests(
  client: ConnectionClient,
  workspaceId: string | null | undefined,
  list: WorktreeList | null,
  refresh: number,
) {
  const cacheScope = useCacheScope(client);
  return usePullRequestSummaries(
    client,
    (workspaceId ? (list?.worktrees ?? []) : []).map((checkout) => {
      const branch = checkout.branch ?? "detached";
      const identity = JSON.stringify([
        cacheScope ?? connectionClientScopeKey(client),
        list?.source.repo_key,
        checkout.path,
        "worktree",
        checkout.is_bare,
        checkout.is_prunable,
      ]);
      return {
        id: checkout.path,
        identity,
        persistent:
          cacheScope !== null && !checkout.is_bare && !checkout.is_prunable,
        branch,
        queryable: true,
        association: connectionClientScopeKey(
          client,
          identity,
          workspaceId,
          branch,
          checkout.is_bare,
          checkout.is_prunable,
        ),
        params: {
          workspace_id: workspaceId,
          worktree_path: checkout.path,
          branch: checkout.branch,
        },
      };
    }),
    refresh,
  );
}

export function useWorkspacePullRequests(
  client: ConnectionClient,
  workspaces: Workspace[],
) {
  const cacheScope = useCacheScope(client);
  const [knownBranches, setKnownBranches] = useState<Record<string, string>>(
    {},
  );
  let observedBranches = knownBranches;
  const targets = workspaces
    .flatMap((workspace) => {
      const worktree = workspace.worktree;
      if (!worktree) return [];
      const reportedBranch = worktree.git_status?.error
        ? undefined
        : worktree.git_status?.branch;
      const identity = JSON.stringify([
        cacheScope ?? connectionClientScopeKey(client),
        worktree.repo_key,
        worktree.checkout_path,
        "workspace",
      ]);
      const branchKey = JSON.stringify([workspace.workspace_id, identity]);
      // Branch identity must survive even when its PR lookup has not succeeded.
      if (reportedBranch && knownBranches[branchKey] !== reportedBranch)
        observedBranches = { ...observedBranches, [branchKey]: reportedBranch };
      const branch = reportedBranch ?? knownBranches[branchKey];
      return [
        {
          id: workspace.workspace_id,
          identity,
          persistent: cacheScope !== null,
          branch,
          queryable: !!reportedBranch,
          association: connectionClientScopeKey(
            client,
            identity,
            workspace.workspace_id,
            branch,
            !!reportedBranch,
          ),
          params: {
            workspace_id: workspace.workspace_id,
            branch,
            latest: true,
          },
        },
      ];
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  if (observedBranches !== knownBranches) setKnownBranches(observedBranches);
  return usePullRequestSummaries(client, targets, 0, true);
}

// Summaries are stale-while-revalidate per target: a refresh keeps the last
// result visible, and unavailable connections/providers keep the last success
// marked stale. Verified branch/checkout changes never inherit another result.
function usePullRequestSummaries(
  client: ConnectionClient,
  targets: SummaryTarget[],
  refresh: number,
  poll = false,
) {
  const ready = useConnectionReady(client);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [entries, setEntries] = useState<Record<string, SummaryEntry>>({});
  const [pollRound, setPollRound] = useState(0);
  // The poll round whose due targets have all been requested and settled.
  const [settledRound, setSettledRound] = useState("");
  const readTargets = useEffectEvent(() => targets);
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  // The association and refresh round each target was last requested for.
  const requested = useRef(
    new Map<string, { association: string; round: string }>(),
  );
  const targetsKey = JSON.stringify(
    targets.map((target) => [target.id, target.association]),
  );
  const pollKey = connectionClientScopeKey(client, pollRound);
  useEffect(() => {
    let cancelled = false;
    const round = JSON.stringify([refresh, pollRound]);
    // Targets that left (a closed dialog, a Git status error) or changed
    // association are requested again when they return; their last summary
    // stays visible meanwhile.
    for (const [id, last] of requested.current) {
      if (
        !readTargets().some(
          (target) =>
            target.id === id && target.association === last.association,
        )
      )
        requested.current.delete(id);
    }
    const current = (target: SummaryTarget) =>
      mounted.current &&
      client.isCurrent() &&
      readTargets().some(
        (next) =>
          next.id === target.id && next.association === target.association,
      );
    const run = async () => {
      const due = readTargets().filter((target) => {
        if (!target.queryable) return false;
        const last = requested.current.get(target.id);
        return last?.association !== target.association || last.round !== round;
      });
      const queue = due.values();
      const worker = async () => {
        for (const target of queue) {
          if (cancelled || !client.isCurrent()) return;
          if (!current(target)) continue;
          const request = { association: target.association, round };
          requested.current.set(target.id, request);
          const status: PullRequestSummary = await client
            .call(
              "git.pull_request",
              {
                ...target.params,
                summary: true,
              },
              65_000,
            )
            .catch(() => ({
              state: "error",
              message: "PR/MR status request failed. Check the connection.",
              retryable: true,
              refreshedAt: new Date().toISOString(),
            }));
          // A reply stays valid for its association even after this effect
          // re-ran; it must never land on a newer association or connection.
          if (!current(target)) {
            if (requested.current.get(target.id) === request)
              requested.current.delete(target.id);
            continue;
          }
          const cached = target.persistent
            ? readPullRequestCache().get(target.identity)
            : undefined;
          if (target.persistent && !pullRequestUnavailable(status))
            writePullRequestCache(target.identity, target.branch, status);
          setEntries((previous) => ({
            ...previous,
            [target.id]: nextEntry(
              lastGoodForTarget(previous[target.id], target) ??
                (cached && cached.branch === target.branch
                  ? cached.status
                  : undefined),
              target,
              status,
            ),
          }));
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      // A run superseded by a target change leaves its remaining targets to
      // the next run of the same round, which settles it instead.
      if (!cancelled && client.isCurrent()) setSettledRound(pollKey);
    };
    // Obsolete replies still occupy host-side CLI slots until they settle.
    pending.current = pending.current.then(run);
    return () => {
      cancelled = true;
    };
  }, [client, ready, targetsKey, refresh, pollRound, pollKey]);

  // Polling waits for each round to settle, but target changes that only
  // request their own targets never postpone the next round for the others.
  const hasTargets = targets.length > 0;
  useEffect(() => {
    if (!poll || !hasTargets || settledRound !== pollKey) return;
    const timer = setTimeout(() => setPollRound((value) => value + 1), 60_000);
    return () => clearTimeout(timer);
  }, [poll, hasTargets, settledRound, pollKey]);

  const cache = readPullRequestCache();
  const statuses: Record<string, PullRequestSummary> = {};
  for (const target of targets) {
    const entry = entries[target.id];
    const cached = target.persistent ? cache.get(target.identity) : undefined;
    const status =
      entry?.association === target.association ? entry.status : undefined;
    const lastGood =
      lastGoodForTarget(entry, target) ??
      (cached && cached.branch === target.branch ? cached.status : undefined);
    if (status && ready && target.queryable) {
      statuses[target.id] = status;
    } else if (lastGood) {
      statuses[target.id] = {
        ...lastGood,
        stale: {
          message: !ready
            ? "Waiting for the connection to recover."
            : !target.queryable
              ? "Git branch status is temporarily unavailable."
              : "Refreshing PR/MR status.",
        },
      };
    }
  }
  return statuses;
}

function lastGoodForTarget(
  entry: SummaryEntry | undefined,
  target: SummaryTarget,
) {
  return entry?.identity === target.identity &&
    entry.branch === target.branch &&
    (target.branch !== "detached" || entry.association === target.association)
    ? entry.lastGood
    : undefined;
}

function nextEntry(
  previous: PullRequestSummary | undefined,
  target: SummaryTarget,
  status: PullRequestSummary,
): SummaryEntry {
  const lastGood =
    status.state === "ready"
      ? status
      : pullRequestUnavailable(status)
        ? previous
        : undefined;
  return {
    association: target.association,
    identity: target.identity,
    branch: target.branch,
    lastGood,
    status:
      status.state !== "ready" && lastGood
        ? {
            ...lastGood,
            stale: { failedAt: status.refreshedAt, message: status.message },
          }
        : status,
  };
}
