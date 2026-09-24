import { randomUUID } from "node:crypto";
import { worktreeSnapshotCommand } from "./git-snapshot";
import { sshCommandArgv } from "../bridge/ssh-command";
import { collectWorktreeFingerprints } from "./git-actions";
import {
  GIT_DIFF_MAX_BYTES,
  GIT_DIFF_TIMEOUT_MS,
  GIT_PULL_TIMEOUT_MS,
  GIT_UNTRACKED_NUMSTAT_CONCURRENCY,
} from "./file-constants";
import { sanitizeExplorerPath } from "./file-paths";
import type {
  GitDiffEntry,
  GitDiffKind,
  GitDiffMode,
  RunProcessWithCodeTimeout,
} from "./file-types";

const GIT_ATTRIBUTE_BATCH_SIZE = 100;
const LAST_STEP_SNAPSHOT_LIMIT = 64;
const LAST_STEP_STORE_DISPOSED = "LAST_STEP_STORE_DISPOSED";

function lastStepStoreDisposedError() {
  return Object.assign(new Error("last-step snapshot store is disposed"), {
    code: LAST_STEP_STORE_DISPOSED,
  });
}

export type LastStepBaselineStore = {
  captureWorkspace: (
    workspaceId: string,
    resolveRoot: () => Promise<string>,
  ) => Promise<string>;
  completeWorkspace: (workspaceId: string) => Promise<boolean>;
  resolveCompleted: (
    workspaceId: string,
    root: string,
  ) => Promise<{ baseline: string; current: string } | undefined>;
  rememberSnapshot: (
    workspaceId: string,
    root: string,
    baseline: string,
    current: string,
  ) => string;
  resolveSnapshot: (
    workspaceId: string,
    root: string,
    snapshotId: string,
  ) => { baseline: string; current: string } | undefined;
  deleteSnapshot: (snapshotId: string) => void;
  invalidateWorkspace: (workspaceId: string, root: string) => void;
  dispose: () => Promise<void>;
};

type WorkspaceActivityCycle = {
  version: number;
  capture: Promise<{ root: string; baseline: string }>;
  completion?: Promise<boolean>;
  nextCapture?: Promise<{ root: string; baseline: string }>;
};

type GitCommandContext = {
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
};

// Git quotes paths containing spaces, quotes, backslashes, or control
// characters C-style ("a\nb"). core.quotepath=false only keeps non-ASCII
// raw, so undo the quoting before using paths as file identities.
export function unquoteGitPath(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) {
    return path;
  }
  const body = path.slice(1, -1);
  let result = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? "";
    if (char !== "\\") {
      result += char;
      continue;
    }
    const next = body[(index += 1)];
    if (next === undefined) {
      result += "\\";
      break;
    }
    if (next >= "0" && next <= "7") {
      const octal = body.slice(index, index + 3);
      if (/^[0-7]{3}$/.test(octal)) {
        result += String.fromCharCode(Number.parseInt(octal, 8));
        index += 2;
        continue;
      }
      result += next;
      continue;
    }
    switch (next) {
      case "a":
        result += "\x07";
        break;
      case "b":
        result += "\b";
        break;
      case "f":
        result += "\f";
        break;
      case "n":
        result += "\n";
        break;
      case "r":
        result += "\r";
        break;
      case "t":
        result += "\t";
        break;
      case "v":
        result += "\v";
        break;
      case "\\":
        result += "\\";
        break;
      default:
        result += next;
    }
  }
  return result;
}

export function statusLabel(code: string, kind: GitDiffKind) {
  if (kind === "untracked") return "untracked";
  if (kind === "conflicted") return "conflicted";
  switch (code) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type changed";
    case "M":
    default:
      return "modified";
  }
}

function isConflictedStatus(x: string, y: string) {
  return (
    x === "U" ||
    y === "U" ||
    (x === "A" && y === "A") ||
    (x === "D" && y === "D")
  );
}

export function parseStatusSummary(output: string): GitDiffEntry[] {
  const entries: GitDiffEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    const rawPath = line.slice(3);
    const renameParts = rawPath.split(" -> ");
    const oldPath =
      renameParts.length > 1 ? unquoteGitPath(renameParts[0] ?? "") : undefined;
    const path = unquoteGitPath(
      renameParts.length > 1 ? renameParts.slice(1).join(" -> ") : rawPath,
    );
    if (!path) continue;

    if (x === "?" && y === "?") {
      entries.push({
        path,
        kind: "untracked",
        status: "untracked",
      });
      continue;
    }
    if (isConflictedStatus(x, y)) {
      entries.push({
        path,
        old_path: oldPath,
        kind: "conflicted",
        status: "conflicted",
      });
      continue;
    }
    if (x !== " ") {
      entries.push({
        path,
        old_path: oldPath,
        kind: "staged",
        status: statusLabel(x, "staged"),
      });
    }
    if (y !== " ") {
      entries.push({
        path,
        old_path: oldPath,
        kind: "unstaged",
        status: statusLabel(y, "unstaged"),
      });
    }
  }
  return entries.sort(
    (a, b) =>
      a.path.localeCompare(b.path, undefined, { sensitivity: "base" }) ||
      a.kind.localeCompare(b.kind),
  );
}

export function parseBranchSummary(
  output: string,
  kind: "branch" | "last-step" = "branch",
): GitDiffEntry[] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const rawStatus = parts[0] ?? "";
      const renamed = rawStatus.startsWith("R") || rawStatus.startsWith("C");
      const path = unquoteGitPath(
        renamed ? (parts[2] ?? parts[1] ?? "") : (parts[1] ?? ""),
      );
      const oldPath =
        renamed && parts[1] ? unquoteGitPath(parts[1]) : undefined;
      return {
        path,
        old_path: oldPath,
        kind,
        status: statusLabel(rawStatus[0] ?? "M", kind),
      };
    })
    .filter((entry) => entry.path)
    .sort((a, b) =>
      a.path.localeCompare(b.path, undefined, { sensitivity: "base" }),
    );
}

function parseNumstatValue(value: string) {
  if (value === "-") return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeNumstatPath(raw: string) {
  const trimmed = raw.trim();
  const tabParts = trimmed.split("\t").filter(Boolean);
  const path = tabParts[tabParts.length - 1] ?? trimmed;
  const braceRename = /\{.*? => (.*?)\}/.exec(path);
  if (braceRename) return path.replace(/\{.*? => (.*?)\}/, "$1");
  const arrowIndex = path.lastIndexOf(" => ");
  if (arrowIndex >= 0) return path.slice(arrowIndex + 4).replace(/[{}]/g, "");
  return path;
}

function parseNumstat(output: string) {
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const additions = parseNumstatValue(parts[0] ?? "0");
    const deletions = parseNumstatValue(parts[1] ?? "0");
    const path = unquoteGitPath(
      normalizeNumstatPath(parts.slice(2).join("\t")),
    );
    if (!path) continue;
    const current = stats.get(path) ?? { additions: 0, deletions: 0 };
    stats.set(path, {
      additions: current.additions + additions,
      deletions: current.deletions + deletions,
    });
  }
  return stats;
}

export function parseGeneratedAttributes(output: string) {
  const generatedPaths = new Set<string>();
  const fields = output.split("\0");
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const path = fields[index] ?? "";
    const attribute = fields[index + 1] ?? "";
    const value = (fields[index + 2] ?? "").toLowerCase();
    if (
      path &&
      attribute === "linguist-generated" &&
      (value === "set" || value === "true")
    ) {
      generatedPaths.add(path);
    }
  }
  return generatedPaths;
}

function entryKeyForStats(entry: Pick<GitDiffEntry, "kind" | "path">) {
  return `${entry.kind}:${entry.path}`;
}

function diffMode(params: Record<string, unknown>): GitDiffMode {
  if (params.mode === "branch-main") return "branch-main";
  if (params.mode === "last-step") return "last-step";
  return "working";
}

function diffFileKind(mode: GitDiffMode, requestedKind: unknown): GitDiffKind {
  if (mode === "branch-main") return "branch";
  if (mode === "last-step") return "last-step";
  if (
    requestedKind === "staged" ||
    requestedKind === "untracked" ||
    requestedKind === "conflicted"
  ) {
    return requestedKind;
  }
  return "unstaged";
}

function workingDiffFileCommand(
  kind: GitDiffKind,
  path: string,
  pathspec: string,
  shQuote: (value: string) => string,
) {
  switch (kind) {
    case "staged":
      return `diff --cached --no-ext-diff -- ${pathspec}`;
    case "untracked":
      return `diff --no-ext-diff --no-index -- /dev/null ${shQuote(path)}`;
    case "conflicted":
      return `diff --cc --no-ext-diff -- ${pathspec}`;
    default:
      return `diff --no-ext-diff -- ${pathspec}`;
  }
}

function runGitShellCommand({
  root,
  command,
  host,
  shQuote,
  runProcessWithCodeTimeout,
  timeoutMs = GIT_DIFF_TIMEOUT_MS,
}: {
  root: string;
  command: string;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  timeoutMs?: number;
}) {
  const fullCommand = `git -C ${shQuote(root)} -c core.quotepath=false ${command}`;
  return runProcessWithCodeTimeout(
    host ? sshCommandArgv(host, fullCommand) : ["sh", "-lc", fullCommand],
    timeoutMs,
  );
}

export async function snapshotWorktreeTree({
  root,
  host,
  shQuote,
  runProcessWithCodeTimeout,
}: { root: string } & GitCommandContext): Promise<string> {
  const command = worktreeSnapshotCommand(root, shQuote);
  const result = await runProcessWithCodeTimeout(
    host ? sshCommandArgv(host, command) : ["sh", "-lc", command],
    GIT_DIFF_TIMEOUT_MS,
  );
  const tree = result.stdout.trim();
  if (result.code !== 0 || !/^[0-9a-f]{40,64}$/.test(tree)) {
    throw new Error(
      (result.stderr || result.stdout || `git write-tree exited ${result.code}`)
        .trim()
        .slice(0, 1000),
    );
  }
  return tree;
}

export function createLastStepBaselineStore(
  context: GitCommandContext,
): LastStepBaselineStore {
  const workspaceVersions = new Map<string, number>();
  const completedRanges = new Map<
    string,
    { root: string; baseline: string; current: string }
  >();
  const completedVersions = new Map<string, number>();
  const activityCycles = new Map<string, WorkspaceActivityCycle>();
  const snapshots = new Map<
    string,
    { workspaceId: string; root: string; baseline: string; current: string }
  >();
  const inFlight = new Set<Promise<unknown>>();
  const snapshotQueues = new Map<string, Promise<unknown>>();
  let disposed = false;
  let disposeTask: Promise<void> | null = null;

  function assertActive() {
    if (disposed) throw lastStepStoreDisposedError();
  }

  function track<T>(task: Promise<T>): Promise<T> {
    inFlight.add(task);
    const remove = () => inFlight.delete(task);
    void task.then(remove, remove);
    return task;
  }

  function clearState() {
    workspaceVersions.clear();
    completedRanges.clear();
    completedVersions.clear();
    activityCycles.clear();
    snapshots.clear();
  }

  function deleteSnapshots(
    predicate: (workspaceId: string, root: string) => boolean,
  ) {
    for (const [snapshotId, snapshot] of snapshots) {
      if (predicate(snapshot.workspaceId, snapshot.root)) {
        snapshots.delete(snapshotId);
      }
    }
  }

  // Serialize captures sharing a checkout within this store. The on-disk
  // quarantine lock also excludes other stores and survives uncertain exits.
  function enqueueForRoot<T>(root: string, task: () => Promise<T>): Promise<T> {
    const prior = snapshotQueues.get(root) ?? Promise.resolve();
    const turn = prior.then(task);
    // The chain carries only the settlement so a failed turn cannot reject
    // later turns; callers still receive the original rejection.
    snapshotQueues.set(
      root,
      turn.then(
        () => undefined,
        () => undefined,
      ),
    );
    return turn;
  }

  async function snapshotRoot(root: string): Promise<string> {
    return enqueueForRoot(root, () =>
      snapshotWorktreeTree({
        root,
        ...context,
      }),
    );
  }

  return {
    captureWorkspace(workspaceId, resolveRoot) {
      if (disposed) return Promise.reject(lastStepStoreDisposedError());
      const priorCycle = activityCycles.get(workspaceId);
      const version = (workspaceVersions.get(workspaceId) ?? 0) + 1;
      workspaceVersions.set(workspaceId, version);
      const capture = track(
        (async () => {
          const root = await resolveRoot();
          assertActive();
          const baseline = await snapshotRoot(root);
          assertActive();
          return { root, baseline };
        })(),
      );
      const cycle = { version, capture };
      activityCycles.set(workspaceId, cycle);
      if (priorCycle?.completion) priorCycle.nextCapture = capture;
      return capture.then((result) => result.baseline);
    },
    completeWorkspace(workspaceId) {
      if (disposed) return Promise.reject(lastStepStoreDisposedError());
      const cycle = activityCycles.get(workspaceId);
      if (!cycle) return Promise.resolve(false);
      if (cycle.completion) return cycle.completion;
      const task = (async () => {
        let captured: { root: string; baseline: string };
        try {
          captured = await cycle.capture;
        } catch {
          return false;
        }
        let current = await snapshotRoot(captured.root);
        if (cycle.nextCapture) {
          try {
            const next = await cycle.nextCapture;
            if (next.root === captured.root) current = next.baseline;
          } catch {
            // Do not publish a potentially late endpoint after a newer period
            // started but failed to establish its boundary snapshot.
            return false;
          }
        }
        if (disposed) return false;
        if ((completedVersions.get(workspaceId) ?? 0) >= cycle.version) {
          return false;
        }
        completedVersions.set(workspaceId, cycle.version);
        completedRanges.set(workspaceId, {
          root: captured.root,
          baseline: captured.baseline,
          current,
        });
        deleteSnapshots(
          (snapshotWorkspaceId) => snapshotWorkspaceId === workspaceId,
        );
        return true;
      })();
      cycle.completion = track(task);
      return cycle.completion;
    },
    async resolveCompleted(workspaceId, root) {
      if (disposed) return undefined;
      const completion = activityCycles.get(workspaceId)?.completion;
      if (completion) {
        try {
          await completion;
        } catch {
          // Preserve the previous completed range when finalization fails.
        }
      }
      const range = completedRanges.get(workspaceId);
      if (!range || range.root !== root) return undefined;
      return { baseline: range.baseline, current: range.current };
    },
    rememberSnapshot(workspaceId, root, baseline, current) {
      assertActive();
      const snapshotId = randomUUID();
      snapshots.set(snapshotId, { workspaceId, root, baseline, current });
      while (snapshots.size > LAST_STEP_SNAPSHOT_LIMIT) {
        const oldest = snapshots.keys().next().value;
        if (typeof oldest !== "string") break;
        snapshots.delete(oldest);
      }
      return snapshotId;
    },
    resolveSnapshot(workspaceId, root, snapshotId) {
      const snapshot = snapshots.get(snapshotId);
      if (
        !snapshot ||
        snapshot.workspaceId !== workspaceId ||
        snapshot.root !== root
      ) {
        return undefined;
      }
      return { baseline: snapshot.baseline, current: snapshot.current };
    },
    deleteSnapshot: (snapshotId) => snapshots.delete(snapshotId),
    invalidateWorkspace(workspaceId, root) {
      deleteSnapshots(
        (snapshotWorkspaceId, snapshotRoot) =>
          snapshotWorkspaceId === workspaceId && snapshotRoot === root,
      );
      const range = completedRanges.get(workspaceId);
      if (range?.root === root) {
        completedRanges.delete(workspaceId);
        completedVersions.delete(workspaceId);
      }
    },
    dispose() {
      if (disposeTask) return disposeTask;
      disposed = true;
      disposeTask = (async () => {
        // Git subprocess failures are owned by their original callers. This
        // shutdown boundary only drains every task before final state clearing.
        await Promise.allSettled(Array.from(inFlight));
        clearState();
        // Uncertain captures own their quarantine until operator recovery.
        snapshotQueues.clear();
      })();
      return disposeTask;
    },
  };
}

async function treeExists({
  root,
  tree,
  host,
  shQuote,
  runProcessWithCodeTimeout,
}: { root: string; tree: string } & GitCommandContext) {
  const result = await runGitShellCommand({
    root,
    command: `cat-file --batch-check=${shQuote("%(objectname) %(objecttype)")} <<'HERDR_EOF'\n${tree}\nHERDR_EOF`,
    host,
    shQuote,
    runProcessWithCodeTimeout,
  });
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `git cat-file exited ${result.code}`)
        .trim()
        .slice(0, 1000),
    );
  }
  const output = result.stdout.trim();
  if (output === `${tree} missing`) return false;
  if (output === `${tree} tree`) return true;
  throw new Error(`unexpected git cat-file response: ${output.slice(0, 1000)}`);
}

async function collectGeneratedPaths({
  root,
  entries,
  host,
  shQuote,
  runProcessWithCodeTimeout,
}: {
  root: string;
  entries: GitDiffEntry[];
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}) {
  const generatedPaths = new Set<string>();
  const paths = Array.from(new Set(entries.map((entry) => entry.path)));
  for (let index = 0; index < paths.length; index += GIT_ATTRIBUTE_BATCH_SIZE) {
    const batch = paths.slice(index, index + GIT_ATTRIBUTE_BATCH_SIZE);
    const result = await runGitShellCommand({
      root,
      command: `check-attr -z linguist-generated -- ${batch.map(shQuote).join(" ")}`,
      host,
      shQuote,
      runProcessWithCodeTimeout,
    });
    if (result.code !== 0) continue;
    for (const path of parseGeneratedAttributes(result.stdout)) {
      generatedPaths.add(path);
    }
  }
  return generatedPaths;
}

async function collectStats({
  root,
  mode,
  base,
  target,
  entries,
  host,
  shQuote,
  runProcessWithCodeTimeout,
}: {
  root: string;
  mode: GitDiffMode;
  base: string | undefined;
  target?: string;
  entries: GitDiffEntry[];
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}) {
  const stats = new Map<string, { additions: number; deletions: number }>();
  const mergeStats = (
    kind: GitDiffKind,
    output: string,
    fallbackKind?: GitDiffKind,
  ) => {
    for (const [path, value] of parseNumstat(output)) {
      stats.set(`${kind}:${path}`, value);
      if (fallbackKind) stats.set(`${fallbackKind}:${path}`, value);
    }
  };

  if (mode === "branch-main" || mode === "last-step") {
    const kind = mode === "branch-main" ? "branch" : "last-step";
    const range =
      mode === "branch-main"
        ? `${shQuote(base ?? "main")}...HEAD`
        : `${shQuote(base ?? "")} ${shQuote(target ?? "")}`;
    const result = await runGitShellCommand({
      root,
      command: `diff --numstat --find-renames ${range}`,
      host,
      shQuote,
      runProcessWithCodeTimeout,
    });
    if (result.code === 0 || result.code === 1) mergeStats(kind, result.stdout);
    return stats;
  }

  const staged = await runGitShellCommand({
    root,
    command: "diff --cached --numstat --find-renames",
    host,
    shQuote,
    runProcessWithCodeTimeout,
  });
  if (staged.code === 0 || staged.code === 1)
    mergeStats("staged", staged.stdout);

  const unstaged = await runGitShellCommand({
    root,
    command: "diff --numstat --find-renames",
    host,
    shQuote,
    runProcessWithCodeTimeout,
  });
  if (unstaged.code === 0 || unstaged.code === 1) {
    mergeStats("unstaged", unstaged.stdout, "conflicted");
  }

  const untrackedEntries = entries.filter(
    (entry) => entry.kind === "untracked",
  );
  let cursor = 0;
  const worker = async () => {
    while (cursor < untrackedEntries.length) {
      const entry = untrackedEntries[cursor];
      cursor += 1;
      if (!entry) continue;
      const result = await runGitShellCommand({
        root,
        command: `diff --no-ext-diff --no-index --numstat -- /dev/null ${shQuote(entry.path)}`,
        host,
        shQuote,
        runProcessWithCodeTimeout,
      });
      if (result.code !== 0 && result.code !== 1) continue;
      const value = parseNumstat(result.stdout).get(entry.path);
      if (value) stats.set(entryKeyForStats(entry), value);
    }
  };
  await Promise.all(
    Array.from(
      {
        length: Math.min(
          GIT_UNTRACKED_NUMSTAT_CONCURRENCY,
          untrackedEntries.length,
        ),
      },
      () => worker(),
    ),
  );

  return stats;
}

async function resolveMainBase({
  root,
  host,
  shQuote,
  runProcessWithCodeTimeout,
}: {
  root: string;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}) {
  const command = `
set -eu
for ref in main refs/heads/main origin/main refs/remotes/origin/main; do
  if git -C ${shQuote(root)} rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then
    printf '%s' "$ref"
    exit 0
  fi
done
exit 1
`;
  const result = await runProcessWithCodeTimeout(
    host ? sshCommandArgv(host, command) : ["sh", "-lc", command],
    GIT_DIFF_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout || "main branch was not found")
        .trim()
        .slice(0, 1000),
    );
  }
  return result.stdout.trim();
}

async function resolveLastStepRange({
  workspaceId,
  root,
  baselines,
  snapshotId,
  host,
  shQuote,
  runProcessWithCodeTimeout,
}: {
  workspaceId: string;
  root: string;
  baselines?: LastStepBaselineStore;
  snapshotId?: string;
} & GitCommandContext) {
  if (snapshotId) {
    const snapshot = baselines?.resolveSnapshot(workspaceId, root, snapshotId);
    if (!snapshot) {
      throw new Error("last-step snapshot expired; refresh Changes");
    }
    return snapshot;
  }

  const completed = await baselines?.resolveCompleted(workspaceId, root);
  if (!completed) return null;
  const [baselineExists, currentExists] = await Promise.all([
    treeExists({
      root,
      tree: completed.baseline,
      host,
      shQuote,
      runProcessWithCodeTimeout,
    }),
    treeExists({
      root,
      tree: completed.current,
      host,
      shQuote,
      runProcessWithCodeTimeout,
    }),
  ]);
  if (!baselineExists || !currentExists) {
    baselines?.invalidateWorkspace(workspaceId, root);
    return null;
  }
  return completed;
}

export async function readDiffSummary({
  workspaceId,
  workspace,
  root,
  params,
  host,
  shQuote,
  runProcessWithCodeTimeout,
  lastStepBaselines,
}: {
  workspaceId: string;
  workspace: any;
  root: string;
  params: Record<string, unknown>;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  lastStepBaselines?: LastStepBaselineStore;
}) {
  const mode = diffMode(params);
  const base =
    mode === "branch-main"
      ? await resolveMainBase({
          root,
          host,
          shQuote,
          runProcessWithCodeTimeout,
        })
      : undefined;
  const lastStepRange =
    mode === "last-step"
      ? await resolveLastStepRange({
          workspaceId,
          root,
          baselines: lastStepBaselines,
          host,
          shQuote,
          runProcessWithCodeTimeout,
        })
      : null;
  let result = { code: 0, stdout: "", stderr: "" };
  if (mode === "branch-main") {
    result = await runGitShellCommand({
      root,
      command: `diff --name-status --find-renames ${shQuote(base ?? "main")}...HEAD`,
      host,
      shQuote,
      runProcessWithCodeTimeout,
    });
  } else if (mode === "last-step" && lastStepRange) {
    result = await runGitShellCommand({
      root,
      command: `diff --name-status --find-renames ${shQuote(lastStepRange.baseline)} ${shQuote(lastStepRange.current)}`,
      host,
      shQuote,
      runProcessWithCodeTimeout,
    });
  } else if (mode === "working") {
    result = await runGitShellCommand({
      root,
      command: "status --porcelain=v1 --untracked-files=all",
      host,
      shQuote,
      runProcessWithCodeTimeout,
    });
  }
  if (result.code !== 0) {
    throw new Error(
      (
        result.stderr ||
        result.stdout ||
        `git ${mode === "working" ? "status" : "diff"} exited ${result.code}`
      )
        .trim()
        .slice(0, 1000),
    );
  }
  let entries: GitDiffEntry[];
  if (mode === "branch-main") {
    entries = parseBranchSummary(result.stdout);
  } else if (mode === "last-step") {
    entries = parseBranchSummary(result.stdout, "last-step");
  } else {
    entries = parseStatusSummary(result.stdout);
  }
  let statsTask: Promise<Map<string, { additions: number; deletions: number }>>;
  if (mode === "last-step" && !lastStepRange) {
    statsTask = Promise.resolve(new Map());
  } else {
    statsTask = collectStats({
      root,
      mode,
      base: mode === "last-step" ? lastStepRange?.baseline : base,
      target: lastStepRange?.current,
      entries,
      host,
      shQuote,
      runProcessWithCodeTimeout,
    });
  }
  const fingerprintTask =
    mode === "working"
      ? collectWorktreeFingerprints(
          { root, host, shQuote, runProcessWithCodeTimeout },
          entries.map((entry) => entry.path),
        )
      : Promise.resolve(new Map<string, { size: number; mtime_ms: number }>());
  const [stats, generatedPaths, fingerprints] = await Promise.all([
    statsTask,
    collectGeneratedPaths({
      root,
      entries,
      host,
      shQuote,
      runProcessWithCodeTimeout,
    }),
    fingerprintTask,
  ]);
  const entriesWithStats = entries.map((entry) => {
    const fingerprint = fingerprints.get(entry.path);
    const entryWithStats = {
      ...entry,
      ...(stats.get(entryKeyForStats(entry)) ?? {}),
      ...(fingerprint
        ? { mtime_ms: fingerprint.mtime_ms, size: fingerprint.size }
        : {}),
    };
    return generatedPaths.has(entry.path)
      ? { ...entryWithStats, generated: true }
      : entryWithStats;
  });
  const lastStepSnapshotId =
    mode === "last-step" && lastStepRange
      ? lastStepBaselines?.rememberSnapshot(
          workspaceId,
          root,
          lastStepRange.baseline,
          lastStepRange.current,
        )
      : undefined;
  return {
    workspace_id: workspaceId,
    repo_name: workspace?.worktree?.repo_name ?? workspace?.label ?? "",
    root,
    mode,
    base: mode === "last-step" ? lastStepRange?.baseline : base,
    baseline_available: mode !== "last-step" || lastStepRange !== null,
    snapshot_id: lastStepSnapshotId,
    entries: entriesWithStats,
    counts: {
      staged: entriesWithStats.filter((entry) => entry.kind === "staged")
        .length,
      unstaged: entriesWithStats.filter((entry) => entry.kind === "unstaged")
        .length,
      untracked: entriesWithStats.filter((entry) => entry.kind === "untracked")
        .length,
      conflicted: entriesWithStats.filter(
        (entry) => entry.kind === "conflicted",
      ).length,
      branch: entriesWithStats.filter((entry) => entry.kind === "branch")
        .length,
      "last-step": entriesWithStats.filter(
        (entry) => entry.kind === "last-step",
      ).length,
    },
  };
}

export async function readDiffFile({
  workspaceId,
  root,
  params,
  host,
  shQuote,
  runProcessWithCodeTimeout,
  lastStepBaselines,
}: {
  workspaceId: string;
  root: string;
  params: Record<string, unknown>;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  lastStepBaselines?: LastStepBaselineStore;
}) {
  const path = sanitizeExplorerPath(params.path);
  if (!path) throw new Error("git.diff_file requires path");
  const oldPath = sanitizeExplorerPath(params.old_path);
  const diffPaths = oldPath && oldPath !== path ? [oldPath, path] : [path];
  const pathspec = diffPaths.map(shQuote).join(" ");
  const mode = diffMode(params);
  const snapshotId =
    typeof params.snapshot_id === "string" && params.snapshot_id
      ? params.snapshot_id
      : undefined;
  if (mode === "last-step" && !snapshotId) {
    throw new Error("last-step diff requires a fresh summary snapshot");
  }
  const base =
    mode === "branch-main"
      ? await resolveMainBase({
          root,
          host,
          shQuote,
          runProcessWithCodeTimeout,
        })
      : undefined;
  const lastStepRange =
    mode === "last-step"
      ? await resolveLastStepRange({
          workspaceId,
          root,
          baselines: lastStepBaselines,
          snapshotId,
          host,
          shQuote,
          runProcessWithCodeTimeout,
        })
      : null;
  const kind = diffFileKind(mode, params.kind);
  let gitCommand: string | null = null;
  if (mode === "branch-main") {
    gitCommand = `diff --no-ext-diff --find-renames ${shQuote(base ?? "main")}...HEAD -- ${pathspec}`;
  } else if (mode === "last-step" && lastStepRange) {
    gitCommand = `diff --no-ext-diff --find-renames ${shQuote(lastStepRange.baseline)} ${shQuote(lastStepRange.current)} -- ${pathspec}`;
  } else if (mode === "working") {
    gitCommand = workingDiffFileCommand(kind, path, pathspec, shQuote);
  }

  let result = { code: 0, stdout: "", stderr: "" };
  if (gitCommand) {
    result = await runGitShellCommand({
      root,
      command: gitCommand,
      host,
      shQuote,
      runProcessWithCodeTimeout,
    });
  }
  const diffExitOk =
    kind === "untracked"
      ? result.code === 0 || result.code === 1
      : result.code === 0;
  if (!diffExitOk) {
    if (mode === "last-step" && snapshotId && lastStepRange) {
      const [baselineExists, currentExists] = await Promise.all([
        treeExists({
          root,
          tree: lastStepRange.baseline,
          host,
          shQuote,
          runProcessWithCodeTimeout,
        }),
        treeExists({
          root,
          tree: lastStepRange.current,
          host,
          shQuote,
          runProcessWithCodeTimeout,
        }),
      ]);
      if (!baselineExists || !currentExists) {
        lastStepBaselines?.deleteSnapshot(snapshotId);
        throw new Error("last-step snapshot expired; refresh Changes");
      }
    }
    throw new Error(
      (result.stderr || result.stdout || `git diff exited ${result.code}`)
        .trim()
        .slice(0, 1000),
    );
  }
  const truncated = Buffer.byteLength(result.stdout) > GIT_DIFF_MAX_BYTES;
  return {
    workspace_id: workspaceId,
    root,
    path,
    kind,
    diff: truncated
      ? result.stdout.slice(0, GIT_DIFF_MAX_BYTES)
      : result.stdout,
    truncated,
  };
}

export async function pullGit({
  workspaceId,
  root,
  host,
  shQuote,
  runProcessWithCodeTimeout,
}: {
  workspaceId: string;
  root: string;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}) {
  const command = `GIT_TERMINAL_PROMPT=0 git -C ${shQuote(root)} -c core.quotepath=false pull --ff-only`;
  const result = await runProcessWithCodeTimeout(
    host ? sshCommandArgv(host, command) : ["sh", "-lc", command],
    GIT_PULL_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `git pull exited ${result.code}`)
        .trim()
        .slice(0, 2000),
    );
  }
  return {
    workspace_id: workspaceId,
    root,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}
