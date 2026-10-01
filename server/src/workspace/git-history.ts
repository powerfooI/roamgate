import { sshCommandArgv } from "../bridge/ssh-command";
import {
  GIT_DIFF_TIMEOUT_MS,
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_MAX_BYTES,
} from "./file-constants";
import { sanitizeExplorerPath } from "./file-paths";
import { decodePreviewBuffer } from "./preview";
import { imageMimeForPath } from "../../../shared/filePreview";
import { readGitPatch, statusLabel } from "./git-diff";
import type { GitDiffEntry, RunProcessWithCodeTimeout } from "./file-types";

type Context = {
  root: string;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
};

function commitId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(value)
  ) {
    throw new Error("invalid commit id");
  }
  return value;
}

async function git(context: Context, command: string) {
  const full = `git -C ${context.shQuote(context.root)} -c core.quotepath=false ${command}`;
  const result = await context.runProcessWithCodeTimeout(
    context.host ? sshCommandArgv(context.host, full) : ["sh", "-lc", full],
    GIT_DIFF_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `git exited ${result.code}`)
        .trim()
        .slice(0, 1000),
    );
  }
  return result.stdout;
}

function parseEntries(
  statusOutput: string,
  statOutput: string,
): GitDiffEntry[] {
  const statuses = statusOutput.split("\0");
  const stats = new Map<
    string,
    Pick<GitDiffEntry, "additions" | "deletions" | "binary">
  >();
  const statFields = statOutput.split("\0");
  for (let i = 0; i < statFields.length - 1; ) {
    const [added = "", deleted = "", path = ""] = (statFields[i++] ?? "").split(
      "\t",
    );
    const actualPath = path || (i++, statFields[i++] ?? "");
    if (actualPath)
      stats.set(
        actualPath,
        added === "-" || deleted === "-"
          ? { binary: true }
          : { additions: Number(added) || 0, deletions: Number(deleted) || 0 },
      );
  }
  const entries: GitDiffEntry[] = [];
  for (let i = 0; i < statuses.length - 1; ) {
    const code = statuses[i++] ?? "";
    const renamed = code.startsWith("R") || code.startsWith("C");
    const first = statuses[i++] ?? "";
    const path = renamed ? (statuses[i++] ?? "") : first;
    if (!path) continue;
    entries.push({
      path,
      ...(renamed ? { old_path: first } : {}),
      kind: "branch",
      status: statusLabel(code[0] ?? "M", "branch"),
      ...stats.get(path),
    });
  }
  return entries;
}

export async function listCommits(
  context: Context,
  params: Record<string, unknown>,
) {
  const offset = params.offset === undefined ? 0 : params.offset;
  if (
    !Number.isSafeInteger(offset) ||
    (offset as number) < 0 ||
    (offset as number) > 100_000
  ) {
    throw new Error("invalid history offset");
  }
  let head = params.head ? commitId(params.head) : "";
  if (!head) {
    const full = `git -C ${context.shQuote(context.root)} rev-parse -q --verify 'HEAD^{commit}'`;
    const result = await context.runProcessWithCodeTimeout(
      context.host ? sshCommandArgv(context.host, full) : ["sh", "-lc", full],
      GIT_DIFF_TIMEOUT_MS,
    );
    if (result.code !== 0)
      return { head: null, commits: [], has_more: false, shallow: false };
    head = commitId(result.stdout.trim());
  }
  const output = await git(
    context,
    `log -z --max-count=31 --skip=${offset} --format='%H%x00%h%x00%an%x00%aI%x00%s' ${context.shQuote(head)}`,
  );
  const fields = output.split("\0");
  const commits = [];
  for (let i = 0; i + 4 < fields.length; i += 5) {
    if (!fields[i]) break;
    commits.push({
      sha: fields[i],
      short_sha: fields[i + 1],
      author: fields[i + 2],
      authored_at: fields[i + 3],
      subject: fields[i + 4],
    });
  }
  const shallow =
    (await git(context, "rev-parse --is-shallow-repository")).trim() === "true";
  return {
    head,
    commits: commits.slice(0, 30),
    has_more: commits.length > 30,
    shallow,
  };
}

export async function readCommit(context: Context, shaValue: unknown) {
  const sha = commitId(shaValue);
  const output = await git(
    context,
    `show -s --format='%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B' ${context.shQuote(sha)}`,
  );
  const fields = output.split("\0");
  if (fields.length < 9) throw new Error("invalid commit metadata");
  let parents = (fields[1] ?? "").split(" ").filter(Boolean);
  if (
    !parents.length &&
    (await git(context, "rev-parse --is-shallow-repository")).trim() === "true"
  ) {
    const raw = await git(context, `cat-file -p ${context.shQuote(sha)}`);
    parents = raw
      .split("\n\n", 1)[0]!
      .split("\n")
      .flatMap((line) => (line.startsWith("parent ") ? [line.slice(7)] : []));
  }
  const base = parents[0] ?? null;
  const shallowBoundary = !!base && !(await gitObjectExists(context, base));
  const args = base
    ? `diff --no-ext-diff --find-renames ${context.shQuote(base)} ${context.shQuote(sha)}`
    : `diff-tree --root --no-commit-id -r --find-renames ${context.shQuote(sha)}`;
  const [status, stat] = shallowBoundary
    ? ["", ""]
    : await Promise.all([
        git(context, `${args} --name-status -z`),
        git(context, `${args} --numstat -z`),
      ]);
  return {
    sha,
    parents,
    base,
    shallow_boundary: shallowBoundary,
    subject: (fields[8] ?? "").split("\n")[0],
    message: fields.slice(8).join("\0").replace(/\n+$/, ""),
    author: { name: fields[2], email: fields[3], date: fields[4] },
    committer: { name: fields[5], email: fields[6], date: fields[7] },
    entries: parseEntries(status, stat),
  };
}

async function gitObjectExists(context: Context, sha: string) {
  const full = `git -C ${context.shQuote(context.root)} cat-file -e ${context.shQuote(`${sha}^{commit}`)}`;
  const result = await context.runProcessWithCodeTimeout(
    context.host ? sshCommandArgv(context.host, full) : ["sh", "-lc", full],
    GIT_DIFF_TIMEOUT_MS,
  );
  return result.code === 0;
}

export async function readCommitFile(
  context: Context,
  params: Record<string, unknown>,
) {
  const sha = commitId(params.sha);
  const base = params.base === null ? null : commitId(params.base);
  const path = sanitizeExplorerPath(params.path);
  if (!path) throw new Error("git.commit_file requires path");
  const oldPath = sanitizeExplorerPath(params.old_path);
  const paths = oldPath && oldPath !== path ? [oldPath, path] : [path];
  const args = base
    ? `diff --no-ext-diff --find-renames ${context.shQuote(base)} ${context.shQuote(sha)}`
    : `diff-tree --root --no-commit-id -r -p --no-ext-diff --find-renames ${context.shQuote(sha)}`;
  const result = await readGitPatch({
    ...context,
    command: `${args} -- ${paths.map(context.shQuote).join(" ")}`,
  });
  if (result.code !== 0)
    throw new Error(
      (result.stderr || result.stdout || `git exited ${result.code}`)
        .trim()
        .slice(0, 1000),
    );
  return {
    path,
    kind: "branch" as const,
    diff: result.diff,
    patch_size: result.patch_size,
    truncated: result.truncated,
  };
}

export async function readCommitPreview(
  context: Context,
  params: Record<string, unknown>,
) {
  const sha = commitId(params.sha);
  const path = sanitizeExplorerPath(params.path);
  if (!path) throw new Error("git.commit_preview requires path");
  const spec = context.shQuote(`${sha}:${path}`);
  const size = Number((await git(context, `cat-file -s ${spec}`)).trim());
  const limit = imageMimeForPath(path)
    ? PREVIEW_IMAGE_MAX_BYTES
    : PREVIEW_MAX_BYTES;
  if (!Number.isFinite(size) || size < 0)
    throw new Error("invalid historical file size");
  if (size > limit)
    return { path, size, truncated: true, text: null, binary: false };
  const encoded = await git(context, `cat-file blob ${spec} | base64`);
  return {
    path,
    size,
    truncated: false,
    ...decodePreviewBuffer(Buffer.from(encoded.trim(), "base64"), false, path),
  };
}
