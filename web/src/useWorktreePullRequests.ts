import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { PullRequestSummary } from "../../shared/pullRequest";
import type { ConnectionClient } from "./api";
import type { Workspace, WorktreeList } from "./types";
import { connectionClientScopeKey } from "./useConnectionClient";

export function useWorktreePullRequests(
  client: ConnectionClient,
  workspaceId: string | null | undefined,
  list: WorktreeList | null,
  refresh: number,
) {
  const key = connectionClientScopeKey(
    client,
    workspaceId,
    list?.source.repo_key,
    list?.worktrees.map(({ label, open_workspace_id, ...checkout }) => {
      void label;
      void open_workspace_id;
      return checkout;
    }),
    refresh,
  );
  return usePullRequestSummaries(
    client,
    key,
    (workspaceId ? (list?.worktrees ?? []) : []).map((worktree) => ({
      id: worktree.path,
      params: {
        workspace_id: workspaceId,
        worktree_path: worktree.path,
        branch: worktree.branch,
      },
    })),
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
              repo: worktree.repo_key,
              path: worktree.checkout_path,
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
  return usePullRequestSummaries(
    client,
    connectionClientScopeKey(client, targets),
    targets,
    true,
  );
}

function usePullRequestSummaries(
  client: ConnectionClient,
  key: string,
  targets: { id: string; params: Record<string, unknown> }[],
  poll = false,
) {
  const [result, setResult] = useState<{
    key: string;
    statuses: Record<string, PullRequestSummary>;
  } | null>(null);
  const readTargets = useEffectEvent(() => targets);
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setResult({ key, statuses: {} });
    const refresh = async () => {
      const currentTargets = readTargets();
      const queue = currentTargets.values();
      const worker = async () => {
        for (const target of queue) {
          if (cancelled || !client.isCurrent()) return;
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
              refreshedAt: new Date().toISOString(),
            }));
          if (cancelled || !client.isCurrent()) return;
          setResult((current) => ({
            key,
            statuses: { ...current?.statuses, [target.id]: status },
          }));
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      if (poll && currentTargets.length && !cancelled && client.isCurrent()) {
        timer = setTimeout(() => {
          pending.current = pending.current.then(refresh);
        }, 60_000);
      }
    };
    // Obsolete replies still occupy host-side CLI slots until they settle.
    pending.current = pending.current.then(refresh);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, key, poll]);

  return client.isCurrent() && result?.key === key ? result.statuses : {};
}
