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
  const validRef = await runGit(`check-ref-format ${shQuote(ref)}`);
  if (validRef.code !== 0) {
    throw new Error(
      "Unable to determine origin's default branch: origin HEAD contains an invalid branch ref.",
    );
  }
  const branch = ref.slice("refs/heads/".length);
  const base = `origin/${branch}`;
  const commit = headResult.stdout.match(
    /^([0-9a-f]{40}|[0-9a-f]{64})\tHEAD\r?$/m,
  )?.[1];
  if (!commit) {
    throw new Error(
      "Unable to determine origin's default commit: origin HEAD does not identify a commit.",
    );
  }
  // Fetch the advertised object, not a mutable ref. Leave tracking refs and
  // shared FETCH_HEAD untouched, even with stale ref prefixes or concurrent fetches.
  const fetchArgs = `fetch --no-tags --no-write-fetch-head --refmap= origin ${shQuote(commit)}`;
  const fetchResult = await runGit(fetchArgs);
  if (fetchResult.code !== 0) {
    throw new Error(
      `Unable to update ${base}: ${processError(fetchResult, `git fetch exited ${fetchResult.code}`)}`,
    );
  }
  const revisionResult = await runGit(
    `rev-parse --verify ${shQuote(`${commit}^{commit}`)}`,
  );
  if (revisionResult.code !== 0 || revisionResult.stdout.trim() !== commit) {
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
