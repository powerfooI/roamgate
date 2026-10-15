export function selectFilePaths(
  selected: Set<string>,
  path: string,
  visiblePaths: string[],
  anchor: string | null,
  range: boolean,
  toggle: boolean,
) {
  const start = anchor === null ? -1 : visiblePaths.indexOf(anchor);
  const end = visiblePaths.indexOf(path);
  if (range && start >= 0 && end >= 0) {
    return new Set([
      ...(toggle ? selected : []),
      ...visiblePaths.slice(Math.min(start, end), Math.max(start, end) + 1),
    ]);
  }
  if (!toggle) return new Set([path]);
  const next = new Set(selected);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}
