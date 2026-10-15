import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { PullRequestSummary } from "../../shared/pullRequest";
import type { ConnectionClient } from "./api";
import type { WorktreeList } from "./types";
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
  const [result, setResult] = useState<{
    key: string;
    statuses: Record<string, PullRequestSummary>;
  } | null>(null);
  const readWorktrees = useEffectEvent(() => list?.worktrees ?? []);
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    const queue = readWorktrees().values();
    setResult({ key, statuses: {} });
    const worker = async () => {
      for (const worktree of queue) {
        if (cancelled || !client.isCurrent()) return;
        const status: PullRequestSummary = await client
          .call(
            "git.pull_request",
            {
              workspace_id: workspaceId,
              worktree_path: worktree.path,
              branch: worktree.branch,
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
          statuses: { ...current?.statuses, [worktree.path]: status },
        }));
      }
    };
    // Obsolete replies still occupy host-side CLI slots until they settle.
    pending.current = pending.current.then(() =>
      Promise.all([worker(), worker(), worker(), worker()]),
    );
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, key]);

  return client.isCurrent() && result?.key === key ? result.statuses : {};
}
