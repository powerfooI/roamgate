import { randomBytes } from "node:crypto";
import { sshCommandArgv } from "../bridge/ssh-command";
import {
  readGuiSettings,
  workspaceRepoSettingsKey,
} from "../config/gui-settings";

type RunProcessWithCodeTimeout = (
  argv: string[],
  timeoutMs: number,
  options?: { env?: NodeJS.ProcessEnv },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export type GitStatusSummary = {
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  dirty: boolean;
  error?: string;
};

export type GitStatusUpdate = {
  checkout_path: string;
  git_status: GitStatusSummary;
};

type CachedGitStatus = {
  /** When the git command that produced `summary` started. */
  loadedAt: number;
  /** Invalidation sequence observed when that command started. */
  loadedSeq: number;
  summary: GitStatusSummary;
};

type GitStatusResult = {
  summary: GitStatusSummary;
  /** ssh or spawn failed, so the summary says nothing about the checkout. */
  transportError?: boolean;
};

/**
 * workspace.list answers from this cache at any age; entries older than this
 * are refreshed in the background and pushed when they change.
 */
export const GIT_STATUS_REFRESH_MS = 20_000;
const GIT_STATUS_TIMEOUT_MS = 8000;
/**
 * How long workspace.list waits for a checkout's first status. A checkout
 * without one reads as detached with no changes, and local git usually
 * answers within this; a slower read (a cold ssh login) is pushed later.
 */
export const GIT_STATUS_COLD_BUDGET_MS = 300;

export function createStatusEnricher(args: {
  connectionId?: string;
  sshHost: () => string | undefined;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  shQuote: (value: string) => string;
  /** Receives only the checkouts whose status changed in a refresh. */
  onGitStatusChanged?: (updates: GitStatusUpdate[]) => void;
  onRefreshError?: (error: unknown) => void;
  readSettings?: typeof readGuiSettings;
  /** Defaults to `GIT_STATUS_COLD_BUDGET_MS`; 0 never waits. */
  coldBudgetMs?: number;
}) {
  const readSettings = args.readSettings ?? readGuiSettings;
  const coldBudgetMs = args.coldBudgetMs ?? GIT_STATUS_COLD_BUDGET_MS;
  // Checkouts a list already waited for, so a slow first read delays only
  // the first list that sees the checkout, not every list until it lands.
  const coldWaited = new Set<string>();
  const gitStatusCache = new Map<string, CachedGitStatus>();
  // Invalidations are ordered by sequence, not time, because a refresh often
  // starts in the same millisecond as the git action that invalidated it.
  const invalidatedSeqs = new Map<string, number>();
  let invalidationSeq = 0;
  // Checkouts and workspace IDs from the latest workspace.list.
  let knownCheckoutPaths: string[] = [];
  let checkoutPathByWorkspace = new Map<string, string>();
  let refreshing: Promise<void> | null = null;
  let refreshAgain = false;
  let disposed = false;

  function gitStatusCacheKey(host: string | undefined, checkoutPath: string) {
    return `${host ?? "local"}\0${checkoutPath}`;
  }

  function gitStatusIsFresh(key: string) {
    const cached = gitStatusCache.get(key);
    return (
      cached !== undefined &&
      Date.now() - cached.loadedAt < GIT_STATUS_REFRESH_MS &&
      cached.loadedSeq >= (invalidatedSeqs.get(key) ?? 0)
    );
  }

  function staleCheckoutPaths(host: string | undefined) {
    return knownCheckoutPaths.filter(
      (path) => !gitStatusIsFresh(gitStatusCacheKey(host, path)),
    );
  }

  function invalidateGitStatus(checkoutPath: string) {
    invalidatedSeqs.set(
      gitStatusCacheKey(args.sshHost(), checkoutPath),
      ++invalidationSeq,
    );
    void refreshInBackground();
  }

  function invalidateWorkspaceGitStatus(workspaceId: string) {
    const checkoutPath = checkoutPathByWorkspace.get(workspaceId);
    if (checkoutPath) invalidateGitStatus(checkoutPath);
  }

  /**
   * Single-flight: a request while a refresh runs schedules one more pass, so
   * an invalidation during an in-flight read is never lost.
   */
  function refreshInBackground(): Promise<void> {
    if (disposed) return refreshing ?? Promise.resolve();
    if (refreshing) {
      refreshAgain = true;
      return refreshing;
    }
    const task = (async () => {
      do {
        if (disposed) return;
        refreshAgain = false;
        const host = args.sshHost();
        const paths = staleCheckoutPaths(host);
        if (paths.length === 0) return;
        await refreshGitStatuses(host, paths);
      } while (refreshAgain);
    })()
      .catch((error) => args.onRefreshError?.(error))
      .finally(() => {
        refreshing = null;
      });
    refreshing = task;
    return task;
  }

  async function refreshGitStatuses(host: string | undefined, paths: string[]) {
    const startedAt = Date.now();
    const startedSeq = invalidationSeq;
    const results = host
      ? await readRemoteGitStatuses(host, paths)
      : new Map(
          await Promise.all(
            paths.map(
              async (path) => [path, await readGitStatus(path)] as const,
            ),
          ),
        );
    if (disposed) return;
    const known = new Set(knownCheckoutPaths);
    const updates: GitStatusUpdate[] = [];
    for (const [path, result] of results) {
      if (!known.has(path)) continue;
      const key = gitStatusCacheKey(host, path);
      const previous = gitStatusCache.get(key);
      // A dropped ssh keeps the last real answer instead of replacing every
      // badge with a transport error; it is retried after the refresh period.
      const summary =
        result.transportError && previous ? previous.summary : result.summary;
      gitStatusCache.set(key, {
        loadedAt: startedAt,
        loadedSeq: startedSeq,
        summary,
      });
      if (
        !previous ||
        JSON.stringify(previous.summary) !== JSON.stringify(summary)
      ) {
        updates.push({ checkout_path: path, git_status: summary });
      }
    }
    if (updates.length > 0) args.onGitStatusChanged?.(updates);
  }

  function emptyGitStatus(): GitStatusSummary {
    return {
      ahead: 0,
      behind: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
      dirty: false,
    };
  }

  function parseGitStatus(output: string): GitStatusSummary {
    const summary = emptyGitStatus();
    for (const line of output.split(/\r?\n/)) {
      if (!line) continue;
      if (line.startsWith("## ")) {
        const header = line.slice(3);
        const match = header.match(/^(.+?)(?:\.\.\.(.*?))?(?: \[(.*)\])?$/);
        if (match) {
          const branch = match[1];
          summary.branch =
            branch === "HEAD (no branch)"
              ? "detached"
              : branch.replace(/^No commits yet on /, "");
          if (match[2]) summary.upstream = match[2];
          const tracking = match[3] ?? "";
          const ahead = tracking.match(/ahead (\d+)/);
          const behind = tracking.match(/behind (\d+)/);
          summary.ahead = ahead ? Number(ahead[1]) : 0;
          summary.behind = behind ? Number(behind[1]) : 0;
        }
        continue;
      }

      const x = line[0];
      const y = line[1];
      if (x === "?" && y === "?") {
        summary.untracked += 1;
        continue;
      }
      const conflicted =
        x === "U" ||
        y === "U" ||
        (x === "A" && y === "A") ||
        (x === "D" && y === "D");
      if (conflicted) {
        summary.conflicted += 1;
        continue;
      }
      if (x && x !== " ") summary.staged += 1;
      if (y && y !== " ") summary.unstaged += 1;
    }
    summary.dirty =
      summary.staged > 0 ||
      summary.unstaged > 0 ||
      summary.untracked > 0 ||
      summary.conflicted > 0;
    return summary;
  }

  async function readGitStatus(checkoutPath: string): Promise<GitStatusResult> {
    try {
      const result = await args.runProcessWithCodeTimeout(
        ["git", "-C", checkoutPath, "status", "--porcelain=v1", "--branch"],
        GIT_STATUS_TIMEOUT_MS,
        // Polling must never take index.lock from the user's own git.
        { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
      );
      if (result.code === 0) return { summary: parseGitStatus(result.stdout) };
      return {
        summary: {
          ...emptyGitStatus(),
          error: (result.stderr || result.stdout || `git exited ${result.code}`)
            .trim()
            .slice(0, 300),
        },
      };
    } catch (e) {
      return {
        summary: {
          ...emptyGitStatus(),
          error: (e as Error).message.slice(0, 300),
        },
        transportError: true,
      };
    }
  }

  async function readRemoteGitStatuses(
    host: string,
    checkoutPaths: string[],
  ): Promise<Map<string, GitStatusResult>> {
    const summaries = new Map<string, GitStatusResult>();
    const marker = `__ROAMGATE_GIT_STATUS_${randomBytes(4).toString("hex")}__`;
    const command = [
      "export GIT_OPTIONAL_LOCKS=0",
      ...checkoutPaths.map(
        (path, index) => `
p=${args.shQuote(path)}
printf '${marker}BEGIN ${index}\\n'
git -C "$p" status --porcelain=v1 --branch 2>&1
code=$?
printf '${marker}END ${index} %s\\n' "$code"
`,
      ),
    ].join("\n");
    const timeoutMs = Math.max(
      GIT_STATUS_TIMEOUT_MS,
      2500 + checkoutPaths.length * 1000,
    );
    const failAll = (error: string) => {
      const summary = { ...emptyGitStatus(), error };
      for (const path of checkoutPaths) {
        summaries.set(path, { summary, transportError: true });
      }
      return summaries;
    };
    let result: { code: number; stdout: string; stderr: string };
    try {
      result = await args.runProcessWithCodeTimeout(
        sshCommandArgv(host, command, [], "git.status.batch"),
        timeoutMs,
      );
    } catch (e) {
      return failAll((e as Error).message.slice(0, 300));
    }

    if (result.code !== 0) {
      return failAll(
        (result.stderr || result.stdout || `ssh exited ${result.code}`)
          .trim()
          .slice(0, 300),
      );
    }

    let currentIndex: number | null = null;
    let currentLines: string[] = [];
    const finish = (index: number, code: number) => {
      const path = checkoutPaths[index];
      if (!path) return;
      const output = currentLines.join("\n");
      const summary =
        code === 0
          ? parseGitStatus(output)
          : {
              ...emptyGitStatus(),
              error: (output || `git exited ${code}`).trim().slice(0, 300),
            };
      summaries.set(path, { summary });
    };

    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.startsWith(`${marker}BEGIN `)) {
        currentIndex = Number(line.slice(`${marker}BEGIN `.length));
        currentLines = [];
        continue;
      }
      if (line.startsWith(`${marker}END `)) {
        const [, rawIndex, rawCode] = line.match(/END (\d+) (\d+)/) ?? [];
        const index = Number(rawIndex);
        const code = Number(rawCode);
        if (currentIndex === index && Number.isFinite(code)) {
          finish(index, code);
        }
        currentIndex = null;
        currentLines = [];
        continue;
      }
      if (currentIndex !== null) currentLines.push(line);
    }

    for (const path of checkoutPaths) {
      if (summaries.has(path)) continue;
      summaries.set(path, {
        summary: {
          ...emptyGitStatus(),
          error: "git status did not return a result",
        },
      });
    }
    return summaries;
  }

  /**
   * Attaches the last known status. Stale or missing entries refresh in the
   * background and changes reach the browser through `onGitStatusChanged`;
   * only a checkout seen for the first time waits, up to `coldBudgetMs`.
   */
  async function enrichWorkspacesWithGitStatus(
    result: unknown,
  ): Promise<unknown> {
    const payload = result as any;
    if (!Array.isArray(payload?.workspaces)) return result;
    const worktreeWorkspaces = payload.workspaces.filter((workspace: any) => {
      const checkoutPath = workspace?.worktree?.checkout_path;
      return typeof checkoutPath === "string" && checkoutPath;
    });
    const host = args.sshHost();
    const settings = await readSettings();
    for (const workspace of worktreeWorkspaces) {
      const key = workspaceRepoSettingsKey(workspace, host, args.connectionId);
      if (!key) continue;
      workspace.worktree.gui_settings_key = key;
      workspace.worktree.worktree_hooks_enabled =
        settings.repositories[key]?.worktree_hooks_enabled !== false;
    }

    checkoutPathByWorkspace = new Map();
    for (const workspace of worktreeWorkspaces) {
      if (typeof workspace.workspace_id === "string") {
        checkoutPathByWorkspace.set(
          workspace.workspace_id,
          workspace.worktree.checkout_path,
        );
      }
    }
    knownCheckoutPaths = [...new Set(checkoutPathByWorkspace.values())];
    const knownKeys = new Set(
      knownCheckoutPaths.map((path) => gitStatusCacheKey(host, path)),
    );
    for (const key of gitStatusCache.keys()) {
      if (!knownKeys.has(key)) gitStatusCache.delete(key);
    }
    for (const key of invalidatedSeqs.keys()) {
      if (!knownKeys.has(key)) invalidatedSeqs.delete(key);
    }
    for (const key of coldWaited) {
      if (!knownKeys.has(key)) coldWaited.delete(key);
    }

    if (staleCheckoutPaths(host).length > 0) {
      const refresh = refreshInBackground();
      const cold = [...knownKeys].filter(
        (key) => !gitStatusCache.has(key) && !coldWaited.has(key),
      );
      if (cold.length > 0 && coldBudgetMs > 0 && !disposed) {
        for (const key of cold) coldWaited.add(key);
        await settledWithin(refresh, coldBudgetMs);
      }
    }
    for (const workspace of worktreeWorkspaces) {
      const cached = gitStatusCache.get(
        gitStatusCacheKey(host, workspace.worktree.checkout_path),
      );
      if (cached) workspace.worktree.git_status = cached.summary;
    }
    return payload;
  }

  return {
    enrichWorkspacesWithGitStatus,
    invalidateGitStatus,
    invalidateWorkspaceGitStatus,
    /** Settles when the background refresh in flight, if any, finishes. */
    gitStatusRefreshSettled: () => refreshing ?? Promise.resolve(),
    /**
     * Stops background refreshes: no new git or ssh process starts and a read
     * already in flight neither updates the cache nor reports a change.
     */
    dispose() {
      disposed = true;
    },
  };
}

async function settledWithin(task: Promise<void>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      task,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
