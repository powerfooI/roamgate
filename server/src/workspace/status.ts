import { randomBytes } from "node:crypto";
import { sshCommandArgv } from "../bridge/ssh-command";
import {
  readGuiSettings,
  workspaceRepoSettingsKey,
} from "../config/gui-settings";

type RunProcessWithCodeTimeout = (
  argv: string[],
  timeoutMs: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;

type GitStatusSummary = {
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

type CachedGitStatus = {
  loadedAt: number;
  summary: GitStatusSummary;
};

const GIT_STATUS_CACHE_MS = 4000;
const GIT_STATUS_TIMEOUT_MS = 8000;

export function createStatusEnricher(args: {
  connectionId?: string;
  sshHost: () => string | undefined;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  shQuote: (value: string) => string;
}) {
  const gitStatusCache = new Map<string, CachedGitStatus>();

  function gitStatusCacheKey(host: string | undefined, checkoutPath: string) {
    return `${host ?? "local"}\0${checkoutPath}`;
  }

  function cachedGitStatus(
    host: string | undefined,
    checkoutPath: string,
  ): GitStatusSummary | null {
    const cached = gitStatusCache.get(gitStatusCacheKey(host, checkoutPath));
    if (!cached || Date.now() - cached.loadedAt >= GIT_STATUS_CACHE_MS) {
      return null;
    }
    return cached.summary;
  }

  function cacheGitStatus(
    host: string | undefined,
    checkoutPath: string,
    summary: GitStatusSummary,
  ) {
    gitStatusCache.set(gitStatusCacheKey(host, checkoutPath), {
      loadedAt: Date.now(),
      summary,
    });
  }

  function invalidateGitStatus(checkoutPath: string) {
    gitStatusCache.delete(gitStatusCacheKey(args.sshHost(), checkoutPath));
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

  async function readGitStatus(
    checkoutPath: string,
  ): Promise<GitStatusSummary> {
    const host = args.sshHost();
    const cached = cachedGitStatus(host, checkoutPath);
    if (cached) return cached;

    try {
      const argv = host
        ? sshCommandArgv(
            host,
            `git -C ${args.shQuote(checkoutPath)} status --porcelain=v1 --branch`,
            [],
            "git.status",
          )
        : ["git", "-C", checkoutPath, "status", "--porcelain=v1", "--branch"];
      const result = await args.runProcessWithCodeTimeout(
        argv,
        GIT_STATUS_TIMEOUT_MS,
      );
      const summary =
        result.code === 0
          ? parseGitStatus(result.stdout)
          : {
              ...emptyGitStatus(),
              error: (
                result.stderr ||
                result.stdout ||
                `git exited ${result.code}`
              )
                .trim()
                .slice(0, 300),
            };
      cacheGitStatus(host, checkoutPath, summary);
      return summary;
    } catch (e) {
      const summary = {
        ...emptyGitStatus(),
        error: (e as Error).message.slice(0, 300),
      };
      cacheGitStatus(host, checkoutPath, summary);
      return summary;
    }
  }

  async function readRemoteGitStatuses(
    host: string,
    checkoutPaths: string[],
  ): Promise<Map<string, GitStatusSummary>> {
    const summaries = new Map<string, GitStatusSummary>();
    const missing: string[] = [];
    for (const path of checkoutPaths) {
      const cached = cachedGitStatus(host, path);
      if (cached) {
        summaries.set(path, cached);
      } else {
        missing.push(path);
      }
    }
    if (missing.length === 0) return summaries;

    const marker = `__ROAMGATE_GIT_STATUS_${randomBytes(4).toString("hex")}__`;
    const command = missing
      .map(
        (path, index) => `
p=${args.shQuote(path)}
printf '${marker}BEGIN ${index}\\n'
git -C "$p" status --porcelain=v1 --branch 2>&1
code=$?
printf '${marker}END ${index} %s\\n' "$code"
`,
      )
      .join("\n");
    const timeoutMs = Math.max(
      GIT_STATUS_TIMEOUT_MS,
      2500 + missing.length * 1000,
    );
    let result: { code: number; stdout: string; stderr: string };
    try {
      result = await args.runProcessWithCodeTimeout(
        sshCommandArgv(host, command, [], "git.status.batch"),
        timeoutMs,
      );
    } catch (e) {
      const summary = {
        ...emptyGitStatus(),
        error: (e as Error).message.slice(0, 300),
      };
      for (const path of missing) {
        cacheGitStatus(host, path, summary);
        summaries.set(path, summary);
      }
      return summaries;
    }

    if (result.code !== 0) {
      const summary = {
        ...emptyGitStatus(),
        error: (result.stderr || result.stdout || `ssh exited ${result.code}`)
          .trim()
          .slice(0, 300),
      };
      for (const path of missing) {
        cacheGitStatus(host, path, summary);
        summaries.set(path, summary);
      }
      return summaries;
    }

    let currentIndex: number | null = null;
    let currentLines: string[] = [];
    const finish = (index: number, code: number) => {
      const path = missing[index];
      if (!path) return;
      const output = currentLines.join("\n");
      const summary =
        code === 0
          ? parseGitStatus(output)
          : {
              ...emptyGitStatus(),
              error: (output || `git exited ${code}`).trim().slice(0, 300),
            };
      cacheGitStatus(host, path, summary);
      summaries.set(path, summary);
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

    for (let index = 0; index < missing.length; index++) {
      const path = missing[index];
      if (summaries.has(path)) continue;
      const summary = {
        ...emptyGitStatus(),
        error: "git status did not return a result",
      };
      cacheGitStatus(host, path, summary);
      summaries.set(path, summary);
    }
    return summaries;
  }

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
    const settings = await readGuiSettings();
    for (const workspace of worktreeWorkspaces) {
      const key = workspaceRepoSettingsKey(workspace, host, args.connectionId);
      if (!key) continue;
      workspace.worktree.gui_settings_key = key;
      workspace.worktree.worktree_hooks_enabled =
        settings.repositories[key]?.worktree_hooks_enabled !== false;
    }

    if (host) {
      const statuses = await readRemoteGitStatuses(
        host,
        worktreeWorkspaces.map(
          (workspace: any) => workspace.worktree.checkout_path,
        ),
      );
      for (const workspace of worktreeWorkspaces) {
        workspace.worktree.git_status = statuses.get(
          workspace.worktree.checkout_path,
        );
      }
      return payload;
    }
    await Promise.all(
      worktreeWorkspaces.map(async (workspace: any) => {
        const checkoutPath = workspace.worktree.checkout_path;
        workspace.worktree.git_status = await readGitStatus(checkoutPath);
      }),
    );
    return payload;
  }

  return { enrichWorkspacesWithGitStatus, invalidateGitStatus };
}
