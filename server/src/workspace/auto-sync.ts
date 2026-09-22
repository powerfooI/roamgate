import type { HerdrClient } from "../bridge/herdr-client";
import { sshCommandArgv } from "../bridge/ssh-command";
import {
  connectionSettingsPrefix,
  DEFAULT_WORKSPACE_AUTO_SYNC_INTERVAL_MINUTES,
  type GuiWorkspaceAutoSyncSettings,
  readGuiSettings,
  updateGuiSettings,
  workspaceAutoSyncSettingsKey,
} from "../config/gui-settings";
import {
  createRecoveryReporter,
  type Logger,
  type RecoveryReporter,
  silentLogger,
} from "../utils/logger";
import { fetchOriginDefaultBranch } from "./default-branch";
import { GIT_PULL_TIMEOUT_MS } from "./file-constants";
import type { RunProcessWithCodeTimeout } from "./file-types";

const AUTO_SYNC_POLL_MS = 30_000;

type SyncResult = Pick<
  GuiWorkspaceAutoSyncSettings,
  "last_status" | "last_message" | "last_branch"
>;

type ProcessResult = {
  code: number;
  stdout: string;
  stderr: string;
};

function processMessage(result: ProcessResult, fallback: string): string {
  return (result.stderr.trim() || result.stdout.trim() || fallback).slice(
    0,
    2_000,
  );
}

function configuredCheckoutPath(
  key: string,
  entry: GuiWorkspaceAutoSyncSettings,
  host: string | undefined,
  connectionId: string | undefined,
): string {
  const prefix = `${connectionSettingsPrefix(connectionId)}${host ? `ssh:${host}:` : "local:"}`;
  if (!key.startsWith(prefix)) return "";
  if (entry.host !== undefined && entry.host !== host) return "";
  if (entry.checkout_path) {
    return workspaceAutoSyncSettingsKey(
      entry.checkout_path,
      host,
      connectionId,
    ) === key
      ? entry.checkout_path
      : "";
  }
  return key.slice(prefix.length);
}

function pathIsWithinRoot(path: string, root: string): boolean {
  const normalizedRoot = root === "/" ? root : root.replace(/\/+$/, "");
  return (
    path === normalizedRoot ||
    path.startsWith(normalizedRoot === "/" ? "/" : `${normalizedRoot}/`)
  );
}

export async function syncWorkspaceBranch({
  root,
  host,
  shQuote,
  runProcessWithCodeTimeout,
}: {
  root: string;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}): Promise<SyncResult> {
  const runGit = (args: string) => {
    const command = `GIT_TERMINAL_PROMPT=0 git -C ${shQuote(root)} ${args}`;
    return runProcessWithCodeTimeout(
      host ? sshCommandArgv(host, command) : ["sh", "-lc", command],
      GIT_PULL_TIMEOUT_MS,
    );
  };

  const repositoryResult = await runGit("rev-parse --is-inside-work-tree");
  if (
    repositoryResult.code !== 0 ||
    repositoryResult.stdout.trim() !== "true"
  ) {
    return {
      last_status: "failed",
      last_message: processMessage(
        repositoryResult,
        "Workspace is no longer inside a Git repository.",
      ),
    };
  }

  const branchResult = await runGit("symbolic-ref --quiet --short HEAD");
  if (branchResult.code !== 0) {
    return {
      last_status: "skipped",
      last_message: "Skipped because the workspace is on a detached HEAD.",
    };
  }
  const branch = branchResult.stdout.trim();

  // Automated merges are only safe when no user changes can be overwritten or
  // mixed into conflict recovery.
  const statusResult = await runGit(
    "status --porcelain=v1 --untracked-files=normal",
  );
  if (statusResult.code !== 0) {
    return {
      last_status: "failed",
      last_message: processMessage(statusResult, "git status failed"),
      last_branch: branch,
    };
  }
  if (statusResult.stdout.trim()) {
    return {
      last_status: "skipped",
      last_message: "Skipped because the workspace has uncommitted changes.",
      last_branch: branch,
    };
  }

  const beforeResult = await runGit("rev-parse HEAD");
  if (beforeResult.code !== 0) {
    return {
      last_status: "failed",
      last_message: processMessage(beforeResult, "Unable to read HEAD"),
      last_branch: branch,
    };
  }

  let baseSync: Awaited<ReturnType<typeof fetchOriginDefaultBranch>>;
  try {
    baseSync = await fetchOriginDefaultBranch(runGit, shQuote);
  } catch (error) {
    return {
      last_status: "failed",
      last_message: (error instanceof Error
        ? error.message
        : String(error)
      ).slice(0, 2_000),
      last_branch: branch,
    };
  }

  // Fetch can take long enough for a user or agent to change branches, commit,
  // or edit files. Never merge into a checkout that changed after preflight.
  const branchAfterFetch = await runGit("symbolic-ref --quiet --short HEAD");
  const statusAfterFetch = await runGit(
    "status --porcelain=v1 --untracked-files=normal",
  );
  const headAfterFetch = await runGit("rev-parse HEAD");
  if (
    branchAfterFetch.code !== 0 ||
    statusAfterFetch.code !== 0 ||
    headAfterFetch.code !== 0
  ) {
    return {
      last_status: "failed",
      last_message: processMessage(
        branchAfterFetch.code !== 0
          ? branchAfterFetch
          : statusAfterFetch.code !== 0
            ? statusAfterFetch
            : headAfterFetch,
        `Unable to verify the workspace after fetching ${baseSync.base}`,
      ),
      last_branch: branch,
    };
  }
  if (
    branchAfterFetch.stdout.trim() !== branch ||
    statusAfterFetch.stdout.trim() ||
    headAfterFetch.stdout.trim() !== beforeResult.stdout.trim()
  ) {
    return {
      last_status: "skipped",
      last_message: `Skipped because the workspace changed while ${baseSync.base} was being fetched.`,
      last_branch: branchAfterFetch.stdout.trim() || branch,
    };
  }

  const mergeResult = await runGit(
    `-c commit.gpgsign=false merge --no-edit --no-stat ${shQuote(baseSync.commit)}`,
  );
  if (mergeResult.code !== 0) {
    // A failed merge may leave conflict state behind. Since the preflight
    // required a clean worktree, aborting restores the exact pre-sync state.
    await runGit("merge --abort");
    return {
      last_status: "failed",
      last_message: processMessage(
        mergeResult,
        `${baseSync.base} could not be merged; the merge was aborted`,
      ),
      last_branch: branch,
    };
  }

  const afterResult = await runGit("rev-parse HEAD");
  if (afterResult.code !== 0) {
    return {
      last_status: "failed",
      last_message: processMessage(afterResult, "Unable to read updated HEAD"),
      last_branch: branch,
    };
  }
  const updated = beforeResult.stdout.trim() !== afterResult.stdout.trim();
  return {
    last_status: updated ? "updated" : "up_to_date",
    last_message: updated
      ? `Merged ${baseSync.base} into ${branch}.`
      : `${branch} is already up to date with ${baseSync.base}.`,
    last_branch: branch,
  };
}

export function createWorkspaceAutoSync(args: {
  connectionId?: string;
  formatError?: (error: unknown) => string;
  logger?: Logger;
  herdr: HerdrClient;
  sshHost: () => string | undefined;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  invalidateGitStatus: (root: string) => void;
  resolveWorkspaceGitRoot: (workspaceId: string) => Promise<{ root: string }>;
  readSettings?: typeof readGuiSettings;
  updateSettings?: typeof updateGuiSettings;
  syncBranch?: typeof syncWorkspaceBranch;
}) {
  const logger = args.logger ?? silentLogger;
  const readSettings = args.readSettings ?? readGuiSettings;
  const updateSettings = args.updateSettings ?? updateGuiSettings;
  const syncBranch = args.syncBranch ?? syncWorkspaceBranch;
  const formatError =
    args.formatError ??
    ((error: unknown) =>
      (error instanceof Error ? error.message : String(error))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 2_000));
  const connectionId = args.connectionId ?? "legacy-default";
  const syncFailureReporters = new Map<string, RecoveryReporter>();
  const tickFailureReporter = createRecoveryReporter({
    logger,
    failureMessage: "workspace auto-sync tick failed",
    recoveryMessage: "workspace auto-sync tick recovered",
  });
  let timer: ReturnType<typeof setInterval> | null = null;
  let started = false;
  let lifecycleGeneration = 0;
  let runningTask: Promise<void> | null = null;
  let stopTask: Promise<void> | null = null;
  let rerunRequested = false;
  const runningKeys = new Set<string>();
  const forcedKeys = new Set<string>();

  function current(generation: number) {
    return started && lifecycleGeneration === generation;
  }

  function syncFailureReporter(key: string): RecoveryReporter {
    let reporter = syncFailureReporters.get(key);
    if (!reporter) {
      reporter = createRecoveryReporter({
        logger,
        failureMessage: "workspace auto-sync failed",
        recoveryMessage: "workspace auto-sync recovered",
      });
      syncFailureReporters.set(key, reporter);
    }
    return reporter;
  }

  async function recordResult(
    generation: number,
    key: string,
    root: string,
    host: string | undefined,
    result: SyncResult,
  ) {
    if (!current(generation)) return;
    await updateSettings((settings) => {
      if (!current(generation)) return settings;
      const existing = settings.workspace_auto_sync[key];
      if (!existing) return settings;
      return {
        ...settings,
        workspace_auto_sync: {
          ...settings.workspace_auto_sync,
          [key]: {
            ...existing,
            ...result,
            checkout_path: root,
            host,
            last_run_at: new Date().toISOString(),
          },
        },
      };
    });
  }

  async function runTick(generation: number) {
    try {
      const settings = await readSettings();
      if (!current(generation)) return;
      const host = args.sshHost();
      const enabledEntries = Object.entries(
        settings.workspace_auto_sync,
      ).filter(
        ([key, entry]) =>
          entry.enabled &&
          !!configuredCheckoutPath(key, entry, host, args.connectionId),
      );
      if (enabledEntries.length === 0) return;

      const workspaceResult = await args.herdr.call("workspace.list");
      if (!current(generation)) return;
      const workspaces = Array.isArray((workspaceResult as any)?.workspaces)
        ? (workspaceResult as any).workspaces
        : [];
      const workspaceByKey = new Map<
        string,
        { workspace: any; root: string }
      >();
      const enabledKeys = new Set(enabledEntries.map(([key]) => key));
      const enabledRoots = enabledEntries
        .map(([key, entry]) => ({
          key,
          root: configuredCheckoutPath(key, entry, host, args.connectionId),
        }))
        .filter(({ root }) => root)
        .sort((a, b) => b.root.length - a.root.length);
      for (const workspace of workspaces) {
        if (!current(generation)) return;
        if (workspaceByKey.size === enabledRoots.length) break;
        const candidates = [
          workspace?.worktree?.checkout_path,
          workspace?.cwd,
        ].filter((path): path is string => typeof path === "string" && !!path);
        const directMatch = enabledRoots.find(({ root }) =>
          candidates.some((path) => pathIsWithinRoot(path, root)),
        );
        if (directMatch && !workspaceByKey.has(directMatch.key)) {
          workspaceByKey.set(directMatch.key, {
            workspace,
            root: directMatch.root,
          });
          continue;
        }
        if (workspace?.workspace_id) {
          try {
            const root = (
              await args.resolveWorkspaceGitRoot(workspace.workspace_id)
            ).root;
            if (!current(generation)) return;
            const key = workspaceAutoSyncSettingsKey(
              root,
              host,
              args.connectionId,
            );
            if (key && enabledKeys.has(key) && !workspaceByKey.has(key)) {
              workspaceByKey.set(key, { workspace, root });
            }
          } catch {
            continue;
          }
        }
      }

      for (const [key] of enabledEntries) {
        if (!current(generation)) return;
        const entry = (await readSettings()).workspace_auto_sync[key];
        if (!current(generation)) return;
        if (!entry?.enabled) {
          forcedKeys.delete(key);
          continue;
        }
        const forced = forcedKeys.has(key);
        const lastRunAt = entry.last_run_at
          ? Date.parse(entry.last_run_at)
          : Number.NaN;
        const intervalMs =
          (entry.interval_minutes ||
            DEFAULT_WORKSPACE_AUTO_SYNC_INTERVAL_MINUTES) * 60_000;
        if (
          !forced &&
          Number.isFinite(lastRunAt) &&
          Date.now() - lastRunAt < intervalMs
        ) {
          continue;
        }

        const target = workspaceByKey.get(key);
        if (!target) continue;
        const { workspace, root } = target;
        forcedKeys.delete(key);
        runningKeys.add(key);
        logger.debug("workspace auto-sync started", {
          connection: connectionId,
          workspace: workspace.workspace_id ?? "unknown",
          path: root,
        });
        let result: SyncResult;
        try {
          result = await syncBranch({
            root,
            host,
            shQuote: args.shQuote,
            runProcessWithCodeTimeout: args.runProcessWithCodeTimeout,
          });
          if (!current(generation)) return;
          args.invalidateGitStatus(root);
        } catch (error) {
          if (!current(generation)) return;
          result = {
            last_status: "failed",
            last_message: formatError(error),
          };
        } finally {
          runningKeys.delete(key);
        }
        await recordResult(generation, key, root, host, result);
        if (!current(generation)) return;
        const resultFields = {
          connection: connectionId,
          workspace: workspace.workspace_id ?? "unknown",
          status: result.last_status ?? "failed",
          detail: formatError(result.last_message ?? ""),
        };
        const reporter = syncFailureReporter(key);
        if (result.last_status === "failed") {
          reporter.failure(result.last_message ?? "sync failed", resultFields);
        } else {
          reporter.recovered(resultFields);
          logger.debug("workspace auto-sync finished", resultFields);
        }
      }
      tickFailureReporter.recovered({ connection: connectionId });
    } catch (error) {
      if (current(generation)) {
        tickFailureReporter.failure(formatError(error), {
          connection: connectionId,
        });
      }
    }
  }

  function tick() {
    if (!started) return Promise.resolve();
    if (runningTask) return runningTask;
    const generation = lifecycleGeneration;
    const task = runTick(generation);
    const wrapped = task.finally(() => {
      if (runningTask !== wrapped) return;
      runningTask = null;
      if (current(generation) && rerunRequested) {
        rerunRequested = false;
        queueMicrotask(() => void tick());
      }
    });
    runningTask = wrapped;
    return wrapped;
  }

  function start() {
    if (started) return;
    started = true;
    lifecycleGeneration += 1;
    stopTask = null;
    timer = setInterval(() => void tick(), AUTO_SYNC_POLL_MS);
    void tick();
  }

  function stop() {
    if (stopTask) return stopTask;
    if (!started && !runningTask) return Promise.resolve();
    started = false;
    lifecycleGeneration += 1;
    if (timer) clearInterval(timer);
    timer = null;
    rerunRequested = false;
    forcedKeys.clear();
    const drain = runningTask ?? Promise.resolve();
    stopTask = drain.finally(() => {
      runningKeys.clear();
    });
    return stopTask;
  }

  function settingsChanged(key: string, enabled: boolean) {
    if (!started) return;
    if (!enabled) {
      forcedKeys.delete(key);
      return;
    }
    forcedKeys.add(key);
    if (runningTask) {
      rerunRequested = true;
      return;
    }
    void tick();
  }

  return {
    start,
    stop,
    settingsChanged,
    isRunning: (key: string) => runningKeys.has(key),
  };
}
