/** Resolve Inspector comparisons using only refs already present in this repository.
 * Never fetch or update tracking refs while inspecting a diff.
 */
export function selectDiffBase(
  refs: { name: string; symbolic?: string }[],
  configuredDefault: string,
  requested?: unknown,
) {
  const branches = refs.filter((ref) => !ref.symbolic).map((ref) => ref.name);
  const existing = new Set(branches);
  const resolve = (name: string) =>
    [name, `refs/heads/${name}`, `refs/remotes/${name}`].find((ref) =>
      existing.has(ref),
    );
  if (requested !== undefined && requested !== "") {
    if (typeof requested !== "string" || !resolve(requested)) {
      throw new Error(
        "Comparison branch was not found; select an existing branch.",
      );
    }
    return { base: resolve(requested)!, branches };
  }
  // A remote HEAD is the repository's recorded default, unlike the current
  // feature branch's upstream. Prefer origin, then other recorded remote HEADs.
  const remoteHeads = refs
    .filter(
      (ref) =>
        ref.name.startsWith("refs/remotes/") &&
        ref.name.endsWith("/HEAD") &&
        ref.symbolic,
    )
    .sort(
      (a, b) =>
        Number(b.name === "refs/remotes/origin/HEAD") -
          Number(a.name === "refs/remotes/origin/HEAD") ||
        a.name.localeCompare(b.name),
    );
  for (const head of remoteHeads) {
    const target = head.symbolic!;
    const remotePrefix = head.name.slice(0, -"HEAD".length);
    const local = target.startsWith(remotePrefix)
      ? `refs/heads/${target.slice(remotePrefix.length)}`
      : target;
    const base = resolve(local) ?? resolve(target);
    if (base) return { base, branches };
  }
  for (const name of [configuredDefault, "main", "master"]) {
    if (!name) continue;
    const base =
      resolve(`refs/heads/${name}`) ?? resolve(`refs/remotes/origin/${name}`);
    if (base) return { base, branches };
  }
  return { base: undefined, branches };
}
