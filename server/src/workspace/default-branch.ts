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
  const trackingResult = await runGit(
    "for-each-ref --format='%(refname) %(objectname) %(symref)' refs/remotes/origin/",
  );
  if (trackingResult.code !== 0) {
    throw new Error(
      `Unable to read origin's tracking refs: ${processError(trackingResult, "git for-each-ref failed")}`,
    );
  }
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
  // Fetch the advertised object, not a mutable ref, without writing shared FETCH_HEAD.
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
  const trackingRef = `refs/remotes/${base}`;
  const trackingRefs = trackingResult.stdout
    .split(/\r?\n/)
    .map((line) => line.split(" "));
  const tracking = trackingRefs.find(([name]) => name === trackingRef);
  // shortcut: Preserve conflicting refs; use fetch --prune for tracking cleanup after renames.
  const normalizedRef = trackingRef.toLowerCase();
  const namespaceBlocked =
    tracking?.[2] ||
    trackingRefs.some(([name]) => {
      const normalizedName = name.toLowerCase();
      return (
        (normalizedName === normalizedRef && name !== trackingRef) ||
        normalizedName.startsWith(`${normalizedRef}/`) ||
        normalizedRef.startsWith(`${normalizedName}/`)
      );
    });
  if (!namespaceBlocked) {
    const symbolicResult = await runGit(
      `symbolic-ref --quiet ${shQuote(trackingRef)}`,
    );
    if (symbolicResult.code !== 0 && symbolicResult.code !== 1) {
      throw new Error(
        `Unable to check ${base}'s tracking ref: ${processError(symbolicResult, "git symbolic-ref failed")}`,
      );
    }
    if (symbolicResult.code === 1) {
      // shortcut: OID CAS cannot guard simultaneous symref edits; use a locking transaction if needed.
      const updateResult = await runGit(
        `update-ref --no-deref ${shQuote(trackingRef)} ${shQuote(commit)} ${shQuote(tracking?.[1] ?? "")}`,
      );
      if (updateResult.code !== 0) {
        const currentRef = await runGit(
          `rev-parse --verify ${shQuote(trackingRef)}`,
        );
        if (currentRef.code !== 0 || currentRef.stdout.trim() !== commit) {
          throw new Error(
            `Unable to update ${base}'s tracking ref: ${processError(updateResult, "git update-ref failed")}`,
          );
        }
      }
    }
  }
  return {
    base,
    commit,
    command: `git ${fetchArgs}`,
    stdout: fetchResult.stdout.trim(),
    stderr: fetchResult.stderr.trim(),
  };
}
