import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { PullRequestSummary } from "../../shared/pullRequest";
import type { ConnectionClient } from "./api";
import type { Workspace, WorktreeList } from "./types";
import { connectionClientScopeKey } from "./useConnectionClient";

type SummaryTarget = {
  id: string;
  /** Changes whenever a previous summary must not be shown for this target. */
  association: string;
  params: Record<string, unknown>;
};

type SummaryEntry = {
  association: string;
  status: PullRequestSummary;
  lastGood?: PullRequestSummary;
};

export function useWorktreePullRequests(
  client: ConnectionClient,
  workspaceId: string | null | undefined,
  list: WorktreeList | null,
  refresh: number,
) {
  return usePullRequestSummaries(
    client,
    (workspaceId ? (list?.worktrees ?? []) : []).map(
      ({ label, open_workspace_id, ...checkout }) => {
        void label;
        void open_workspace_id;
        return {
          id: checkout.path,
          association: connectionClientScopeKey(
            client,
            workspaceId,
            list?.source.repo_key,
            checkout,
          ),
          params: {
            workspace_id: workspaceId,
            worktree_path: checkout.path,
            branch: checkout.branch,
          },
        };
      },
    ),
    refresh,
  );
}

export function useWorkspacePullRequests(
  client: ConnectionClient,
  workspaces: Workspace[],
) {
  const targets = workspaces
    .flatMap((workspace) => {
      const worktree = workspace.worktree;
      const branch = worktree?.git_status?.branch;
      return worktree && branch && !worktree.git_status?.error
        ? [
            {
              id: workspace.workspace_id,
              association: connectionClientScopeKey(
                client,
                workspace.workspace_id,
                worktree.repo_key,
                worktree.checkout_path,
                branch,
              ),
              params: {
                workspace_id: workspace.workspace_id,
                branch,
                latest: true,
              },
            },
          ]
        : [];
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  return usePullRequestSummaries(client, targets, 0, true);
}

// Summaries are stale-while-revalidate per target: a refresh keeps the last
// result for an unchanged association visible, and a retryable failure keeps
// the last successful one marked stale. Any association change hides it.
function usePullRequestSummaries(
  client: ConnectionClient,
  targets: SummaryTarget[],
  refresh: number,
  poll = false,
) {
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
      client.isCurrent() &&
      readTargets().some(
        (next) =>
          next.id === target.id && next.association === target.association,
      );
    const run = async () => {
      const due = readTargets().filter((target) => {
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
          setEntries((previous) => ({
            ...previous,
            [target.id]: nextEntry(
              previous[target.id]?.association === target.association
                ? previous[target.id]
                : undefined,
              target.association,
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
  }, [client, targetsKey, refresh, pollRound, pollKey]);

  // Polling waits for each round to settle, but target changes that only
  // request their own targets never postpone the next round for the others.
  const hasTargets = targets.length > 0;
  useEffect(() => {
    if (!poll || !hasTargets || settledRound !== pollKey) return;
    const timer = setTimeout(() => setPollRound((value) => value + 1), 60_000);
    return () => clearTimeout(timer);
  }, [poll, hasTargets, settledRound, pollKey]);

  const statuses: Record<string, PullRequestSummary> = {};
  if (!client.isCurrent()) return statuses;
  for (const target of targets) {
    const entry = entries[target.id];
    if (entry?.association === target.association)
      statuses[target.id] = entry.status;
  }
  return statuses;
}

function nextEntry(
  previous: SummaryEntry | undefined,
  association: string,
  status: PullRequestSummary,
): SummaryEntry {
  if (status.state === "ready")
    return { association, status, lastGood: status };
  // Authoritative results (no_match, detached, branch changes, ...) replace
  // the last success; only retryable failures fall back to it.
  const lastGood =
    status.state === "error" && status.retryable
      ? previous?.lastGood
      : undefined;
  return {
    association,
    lastGood,
    status: lastGood
      ? {
          ...lastGood,
          stale: { failedAt: status.refreshedAt, message: status.message },
        }
      : status,
  };
}
