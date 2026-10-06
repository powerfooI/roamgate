import { gitShellCommandArgv } from "./git-shell";
import { GIT_DIFF_TIMEOUT_MS } from "./file-constants";
import { sanitizeExplorerPath } from "./file-paths";
import type { RunProcessWithCodeTimeout } from "./file-types";

export const GIT_FILE_ACTIONS = [
  "stage",
  "unstage",
  "discard_unstaged",
  "delete_untracked",
] as const;
export type GitFileAction = (typeof GIT_FILE_ACTIONS)[number];

export const GIT_REPO_ACTIONS = [
  "stage_all",
  "unstage_all",
  "discard_all_unstaged",
  "delete_all_untracked",
] as const;
export type GitRepoAction = (typeof GIT_REPO_ACTIONS)[number];

const FINGERPRINT_BATCH_SIZE = 100;
const MAX_ACTION_OUTPUT = 1000;

export type GitActionContext = {
  root: string;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
};

export type WorktreeFingerprint = {
  size: number;
  mtime_ms: number;
};

function gitChangedError(path: string) {
  return new Error(
    `${path} changed since the last refresh; refresh Changes and try again`,
  );
}

function parseAction<T extends string>(
  value: unknown,
  allowed: readonly T[],
  method: string,
): T {
  if (
    typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
  ) {
    return value as T;
  }
  throw new Error(`${method} requires a valid action`);
}

async function runGit(
  context: GitActionContext,
  command: string,
  timeoutMs = GIT_DIFF_TIMEOUT_MS,
) {
  const fullCommand = `git -C ${context.shQuote(context.root)} -c core.quotepath=false ${command}`;
  const result = await context.runProcessWithCodeTimeout(
    gitShellCommandArgv(fullCommand, context.host),
    timeoutMs,
  );
  return result;
}

async function runGitOrThrow(context: GitActionContext, command: string) {
  const result = await runGit(context, command);
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `git exited ${result.code}`)
        .trim()
        .slice(0, MAX_ACTION_OUTPUT),
    );
  }
  return result;
}

async function headExists(context: GitActionContext) {
  const result = await runGit(
    context,
    "rev-parse --verify --quiet 'HEAD^{commit}'",
  );
  return result.code === 0 && Boolean(result.stdout.trim());
}

function isConflictedStatus(x: string, y: string) {
  return (
    x === "U" ||
    y === "U" ||
    (x === "A" && y === "A") ||
    (x === "D" && y === "D")
  );
}

export function porcelainAllowsFileAction(
  action: GitFileAction,
  porcelainOutput: string,
): boolean {
  const line = porcelainOutput.split(/\r?\n/).find(Boolean);
  if (!line) return false;
  const x = line[0] ?? " ";
  const y = line[1] ?? " ";
  const untracked = x === "?" && y === "?";
  const conflicted = isConflictedStatus(x, y);
  switch (action) {
    case "stage":
      // Conflicted files are staged to mark them resolved.
      return untracked || conflicted || y !== " ";
    case "unstage":
      return !untracked && !conflicted && x !== " ";
    case "discard_unstaged":
      return !untracked && !conflicted && y !== " ";
    case "delete_untracked":
      return untracked;
    default:
      return false;
  }
}

export function parseFingerprintListing(output: string) {
  const fingerprints = new Map<string, WorktreeFingerprint>();
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const [rawPath, rawSize, rawMtime] = line.split("\t");
    if (!rawPath) continue;
    const path = Buffer.from(rawPath, "base64").toString("utf8");
    const size = Number(rawSize);
    const mtimeSec = Number(rawMtime);
    if (!path || !Number.isFinite(size) || !Number.isFinite(mtimeSec)) {
      continue;
    }
    fingerprints.set(path, { size, mtime_ms: mtimeSec * 1000 });
  }
  return fingerprints;
}

// Stats worktree files in batches with a single shell round trip per batch so
// SSH-backed workspaces stay cheap. Missing files are simply absent from the
// result. Paths are prefixed with ./ so leading dashes cannot be misparsed.
export async function collectWorktreeFingerprints(
  context: GitActionContext,
  paths: string[],
): Promise<Map<string, WorktreeFingerprint>> {
  const fingerprints = new Map<string, WorktreeFingerprint>();
  const unique = Array.from(new Set(paths)).filter(Boolean);
  for (let index = 0; index < unique.length; index += FINGERPRINT_BATCH_SIZE) {
    const batch = unique.slice(index, index + FINGERPRINT_BATCH_SIZE);
    const command = `
set -- ${batch.map(context.shQuote).join(" ")}
cd -- ${context.shQuote(context.root)}
for p in "$@"; do
  f="./$p"
  [ -f "$f" ] || continue
  values="$( (stat -c '%s %Y' "$f" 2>/dev/null || stat -f '%z %m' "$f" 2>/dev/null) )"
  [ -n "$values" ] || continue
  printf '%s\t%s\t%s\n' "$(printf '%s' "$p" | base64 | tr -d '\n')" "\${values%% *}" "\${values##* }"
done
`;
    const result = await context.runProcessWithCodeTimeout(
      gitShellCommandArgv(command, context.host),
      GIT_DIFF_TIMEOUT_MS,
    );
    if (result.code !== 0) continue;
    for (const [path, fingerprint] of parseFingerprintListing(result.stdout)) {
      fingerprints.set(path, fingerprint);
    }
  }
  return fingerprints;
}

function sanitizedActionPaths(params: Record<string, unknown>, method: string) {
  const path = sanitizeExplorerPath(params.path);
  if (!path) throw new Error(`${method} requires path`);
  const oldPath = sanitizeExplorerPath(params.old_path);
  return { path, oldPath };
}

function expectedFingerprint(
  params: Record<string, unknown>,
): WorktreeFingerprint | undefined {
  const mtimeMs = Number(params.mtime_ms);
  const size = Number(params.size);
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return undefined;
  if (!Number.isFinite(size) || size < 0) return undefined;
  return { mtime_ms: mtimeMs, size };
}

async function assertPorcelainAllows(
  context: GitActionContext,
  action: GitFileAction,
  path: string,
) {
  const result = await runGitOrThrow(
    context,
    `status --porcelain=v1 --untracked-files=all -- ${context.shQuote(path)}`,
  );
  if (!porcelainAllowsFileAction(action, result.stdout)) {
    throw gitChangedError(path);
  }
}

// `git clean -f` silently skips untracked directories and still exits 0,
// which would report a misleading success; refuse them explicitly instead.
// Recursive directory deletion is intentionally out of scope. Symlinks are
// fine: clean removes the link itself, even when it points at a directory.
async function runDeleteUntracked(context: GitActionContext, path: string) {
  const script = `
set -eu
cd -- ${context.shQuote(context.root)}
f=${context.shQuote(`./${path}`)}
if [ -d "$f" ] && [ ! -L "$f" ]; then
  echo "delete_untracked supports files only; recursive directory deletion is not supported" >&2
  exit 15
fi
git -c core.quotepath=false clean -f -- ${context.shQuote(path)}
`;
  const result = await context.runProcessWithCodeTimeout(
    gitShellCommandArgv(script, context.host),
    GIT_DIFF_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `git clean exited ${result.code}`)
        .trim()
        .slice(0, MAX_ACTION_OUTPUT),
    );
  }
}

function pathspecsFor(
  path: string,
  oldPath: string,
  context: GitActionContext,
) {
  const paths = oldPath && oldPath !== path ? [oldPath, path] : [path];
  return paths.map(context.shQuote).join(" ");
}

export async function runGitFileAction({
  context,
  params,
}: {
  context: GitActionContext;
  params: Record<string, unknown>;
}) {
  const action = parseAction(
    params.action,
    GIT_FILE_ACTIONS,
    "git.file_action",
  );
  const { path, oldPath } = sanitizedActionPaths(params, "git.file_action");
  await assertPorcelainAllows(context, action, path);
  if (action === "discard_unstaged" || action === "delete_untracked") {
    const expected = expectedFingerprint(params);
    const current = (await collectWorktreeFingerprints(context, [path])).get(
      path,
    );
    if (!expected) {
      // Fail closed: without the summary fingerprint there is no way to tell
      // whether the file changed after the menu opened. A missing worktree
      // file stays allowed (restoring a deletion, or a broken symlink that
      // never produces a fingerprint); the porcelain re-check above already
      // pinned that state down.
      if (current) throw gitChangedError(path);
    } else if (
      !current ||
      current.size !== expected.size ||
      Math.trunc(current.mtime_ms / 1000) !==
        Math.trunc(expected.mtime_ms / 1000)
    ) {
      throw gitChangedError(path);
    }
  }

  if (action === "delete_untracked") {
    await runDeleteUntracked(context, path);
    return { action, path, old_path: oldPath || undefined };
  }

  let command: string;
  switch (action) {
    case "stage":
      command = `add -- ${context.shQuote(path)}`;
      break;
    case "unstage":
      command = (await headExists(context))
        ? `reset -q HEAD -- ${pathspecsFor(path, oldPath, context)}`
        : `rm -q --cached -- ${pathspecsFor(path, oldPath, context)}`;
      break;
    case "discard_unstaged":
      // Restores the worktree from the index, so a staged version survives.
      command = `checkout -- ${context.shQuote(path)}`;
      break;
    default:
      throw new Error(`unsupported git file action: ${action}`);
  }
  await runGitOrThrow(context, command);
  return { action, path, old_path: oldPath || undefined };
}

export type WorkingTreeCounts = {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
};

export function parseWorkingTreeCounts(output: string): WorkingTreeCounts {
  const counts: WorkingTreeCounts = {
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
  };
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    if (x === "?" && y === "?") {
      counts.untracked += 1;
      continue;
    }
    if (isConflictedStatus(x, y)) {
      counts.conflicted += 1;
      continue;
    }
    if (x !== " ") counts.staged += 1;
    if (y !== " ") counts.unstaged += 1;
  }
  return counts;
}

async function readWorkingTreeCounts(context: GitActionContext) {
  const result = await runGitOrThrow(
    context,
    "status --porcelain=v1 --untracked-files=all",
  );
  return parseWorkingTreeCounts(result.stdout);
}

function expectedCounts(
  params: Record<string, unknown>,
): Partial<WorkingTreeCounts> | undefined {
  const raw = params.expected_counts;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const counts: Partial<WorkingTreeCounts> = {};
  for (const key of [
    "staged",
    "unstaged",
    "untracked",
    "conflicted",
  ] as const) {
    const value = Number(record[key]);
    if (Number.isSafeInteger(value) && value >= 0) counts[key] = value;
  }
  return Object.keys(counts).length ? counts : undefined;
}

async function assertCountsFresh(
  context: GitActionContext,
  expected: Partial<WorkingTreeCounts> | undefined,
  keys: (keyof WorkingTreeCounts)[],
) {
  if (!expected) return;
  const current = await readWorkingTreeCounts(context);
  const stale = keys.some(
    (key) =>
      typeof expected[key] === "number" && expected[key] !== current[key],
  );
  if (stale) {
    throw new Error(
      "the working tree changed since the last refresh; refresh Changes and try again",
    );
  }
}

export async function runGitRepoAction({
  context,
  params,
}: {
  context: GitActionContext;
  params: Record<string, unknown>;
}) {
  const action = parseAction(
    params.action,
    GIT_REPO_ACTIONS,
    "git.repo_action",
  );
  const expected = expectedCounts(params);

  let command: string;
  switch (action) {
    case "stage_all":
      command = "add -A";
      break;
    case "unstage_all":
      command = (await headExists(context))
        ? "reset -q"
        : "rm -r -q --cached .";
      break;
    case "discard_all_unstaged": {
      await assertCountsFresh(context, expected, ["unstaged"]);
      const counts = await readWorkingTreeCounts(context);
      if (counts.conflicted > 0) {
        throw new Error(
          "resolve conflicted files before discarding all unstaged changes",
        );
      }
      // Restores the worktree from the index, so staged changes survive.
      command = "checkout -- .";
      break;
    }
    case "delete_all_untracked":
      await assertCountsFresh(context, expected, ["untracked"]);
      // No -x: files excluded via .gitignore/info/exclude are preserved.
      command = "clean -fd";
      break;
    default:
      throw new Error(`unsupported git repository action: ${action}`);
  }
  await runGitOrThrow(context, command);
  const counts = await readWorkingTreeCounts(context);
  return { action, counts };
}
