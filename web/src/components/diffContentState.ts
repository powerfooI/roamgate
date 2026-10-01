const diffCollapseStateCache = new Map<string, ReadonlyMap<string, boolean>>();

export function readDiffCollapseState(resourceKey: string) {
  return diffCollapseStateCache.get(resourceKey);
}

export function writeDiffCollapseState(
  resourceKey: string,
  state: ReadonlyMap<string, boolean>,
) {
  diffCollapseStateCache.delete(resourceKey);
  diffCollapseStateCache.set(resourceKey, state);
  while (diffCollapseStateCache.size > 8) {
    diffCollapseStateCache.delete(diffCollapseStateCache.keys().next().value!);
  }
}

export function clearDiffContentResourceState(resourceKey: string) {
  diffCollapseStateCache.delete(resourceKey);
}

/** Selecting a file is an explicit request to view it: record a manual
 *  expand so prior manual collapses and auto-collapse defaults yield. */
export function expandDiffEntryOnActivate(
  current: ReadonlyMap<string, boolean> | undefined,
  key: string,
  autoCollapsed = false,
  explicit = false,
): ReadonlyMap<string, boolean> {
  if (autoCollapsed && !explicit) return current ?? new Map();
  if (current?.get(key) === false) return current;
  const next = new Map(current);
  next.set(key, false);
  return next;
}

export function diffSectionCollapsed({
  continuous,
  embedded,
  active,
  manual,
  autoCollapsed,
}: {
  continuous: boolean;
  embedded: boolean;
  active: boolean;
  manual: boolean | undefined;
  autoCollapsed: boolean;
}) {
  return !embedded && ((!continuous && !active) || (manual ?? autoCollapsed));
}

export const MAX_NEARBY_DIFF_FILES = 12;

export function visibleDiffEntryKey(
  sections: { key: string; top: number; bottom: number }[],
  viewport: { top: number; bottom: number },
) {
  return (
    sections
      .filter(
        (section) =>
          section.bottom > viewport.top + 1 && section.top < viewport.bottom,
      )
      .sort((a, b) => a.top - b.top)[0]?.key ?? null
  );
}

export function nearestDiffEntryKeys(
  sections: { key: string; top: number; bottom: number }[],
  viewport: { top: number; bottom: number },
) {
  const distance = (section: { top: number; bottom: number }) =>
    Math.max(0, section.top - viewport.bottom, viewport.top - section.bottom);
  return [...sections]
    .sort((a, b) => distance(a) - distance(b) || a.top - b.top)
    .slice(0, MAX_NEARBY_DIFF_FILES)
    .map((section) => section.key);
}
