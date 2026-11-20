import type { Pane, PaneLayout } from "./types";

/**
 * Last observed geometry per tab. Switching to another tab would otherwise
 * blank the terminal area until `pane.layout` answers, because the store has
 * no layout for a tab it is not currently showing.
 */
const layoutByTab = new Map<string, PaneLayout>();

function layoutKey(connectionId: string, generation: number, tabId: string) {
  return `${connectionId}\0${generation}\0${tabId}`;
}

export function rememberTabLayout(
  connectionId: string,
  generation: number,
  layout: PaneLayout | null,
) {
  if (!connectionId || !layout?.tab_id) return;
  layoutByTab.set(layoutKey(connectionId, generation, layout.tab_id), layout);
}

export function tabLayoutFor(
  connectionId: string,
  generation: number,
  tabId: string | undefined,
): PaneLayout | null {
  if (!connectionId || !tabId) return null;
  return layoutByTab.get(layoutKey(connectionId, generation, tabId)) ?? null;
}

export function forgetTabLayoutsExcept(
  connectionId: string,
  generation: number,
  tabIds: Set<string>,
) {
  const prefix = `${connectionId}\0${generation}\0`;
  for (const key of layoutByTab.keys()) {
    if (!key.startsWith(prefix)) continue;
    if (!tabIds.has(key.slice(prefix.length))) layoutByTab.delete(key);
  }
}

export function clearTabLayouts() {
  layoutByTab.clear();
}

/**
 * Geometry to render a tab with before its own `pane.layout` arrives. Cached
 * geometry is reused only while it still describes exactly the panes the tab
 * has, since a split or close since the last visit moves every rect. A single
 * pane needs no cache: it always fills its tab. Without either, the pane gone
 * to fills the tab alone until the split arrives, rather than nothing at all.
 */
export function provisionalTabLayout(
  cached: PaneLayout | null,
  panes: readonly Pane[],
  tabId: string | undefined,
  paneId?: string | null,
): PaneLayout | null {
  if (!tabId) return null;
  const tabPanes = panes.filter((pane) => pane.tab_id === tabId);
  if (tabPanes.length === 0) return null;
  if (cached?.tab_id === tabId) {
    const cachedPaneIds = new Set(cached.panes.map((pane) => pane.pane_id));
    if (
      cachedPaneIds.size === tabPanes.length &&
      tabPanes.every((pane) => cachedPaneIds.has(pane.pane_id))
    ) {
      return cached;
    }
  }
  const alone =
    tabPanes.length === 1
      ? tabPanes[0]
      : tabPanes.find((pane) => pane.pane_id === paneId);
  if (!alone) return null;
  const unit = { x: 0, y: 0, width: 1, height: 1 };
  return {
    workspace_id: alone.workspace_id,
    tab_id: tabId,
    zoomed: false,
    area: { ...unit },
    focused_pane_id: alone.pane_id,
    panes: [{ pane_id: alone.pane_id, focused: true, rect: { ...unit } }],
    splits: [],
  };
}
