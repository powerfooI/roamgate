type GitResult = { code: number; stdout: string; stderr: string };

function processError(result: GitResult, fallback: string): string {
  return (result.stderr.trim() || result.stdout.trim() || fallback).slice(
    0,
    2_000,
  );
}

/** Query the remote on every sync: the clone's origin/HEAD may be stale. */
export async function fetchOriginDefaultBranch(
  runGit: (args: string) => Promise<GitResult>,
  shQuote: (value: string) => string,
) {
  const headResult = await runGit("ls-remote --symref origin HEAD");
  if (headResult.code !== 0) {
    throw new Error(
      `Unable to determine origin's default branch: ${processError(headResult, "git ls-remote failed")}`,
    );
  }
  const ref = headResult.stdout.match(
    /^ref: (refs\/heads\/[^\r\n]+)\tHEAD\r?$/m,
  )?.[1];
  if (!ref) {
    throw new Error(
      "Unable to determine origin's default branch: origin HEAD does not identify a branch.",
    );
  }
  // Fetch follows symbolic destinations, and a ref cannot contain child refs.
  // Reserve origin/HEAD and descendants case-insensitively on every host.
  if (/^refs\/heads\/head(?:\/|$)/i.test(ref)) {
    throw new Error(
      "Cannot fetch origin's default branch: origin/HEAD is reserved, including descendants (case-insensitive). Choose another default branch on origin.",
    );
  }
  const validRef = await runGit(`check-ref-format ${shQuote(ref)}`);
  if (validRef.code !== 0) {
    throw new Error(
      "Unable to determine origin's default branch: origin HEAD contains an invalid branch ref.",
    );
  }
  const branch = ref.slice("refs/heads/".length);
  const base = `origin/${branch}`;
  const trackingRef = `refs/remotes/${base}`;
  // Explicitly update the tracking ref even with a narrow remote fetch config.
  const fetchArgs = `fetch --no-tags origin ${shQuote(`+${ref}:${trackingRef}`)}`;
  const fetchResult = await runGit(fetchArgs);
  if (fetchResult.code !== 0) {
    throw new Error(
      `Unable to update ${base}: ${processError(fetchResult, `git fetch exited ${fetchResult.code}`)}`,
    );
  }
  const revisionResult = await runGit(
    `rev-parse --verify ${shQuote(`${trackingRef}^{commit}`)}`,
  );
  const commit = revisionResult.stdout.trim();
  if (revisionResult.code !== 0 || !commit) {
    throw new Error(
      `Unable to resolve ${base} after fetching it: ${processError(revisionResult, `${base} does not point to a commit`)}`,
    );
  }
  return {
    base,
    commit,
    command: `git ${fetchArgs}`,
    stdout: fetchResult.stdout.trim(),
    stderr: fetchResult.stderr.trim(),
  };
}
