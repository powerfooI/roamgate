import type { ConnectionSessionView } from "./connectionSessions";
import { normalizeSearchText } from "./searchText";
import { shortId } from "./utils";
import type { Pane, PaneLayout, Tab, Workspace } from "./types";
import type {
  ServerAgentPane,
  ServerSessionSource,
} from "./useAllServerAgentSessions";

export type PaneJumpEntry = {
  /** Unique across connections: pane ids are only unique within one. */
  key: string;
  paneId: string;
  paneLabel: string;
  title: string;
  tabLabel: string;
  cwd: string;
  agent?: string;
  agentStatus?: string;
  current: boolean;
  /** Set when results span several servers. */
  serverLabel?: string;
  /** Set for panes that live on a server other than the active one. */
  source?: ServerSessionSource & { workspaceId: string };
  /** Set for a pane on a connection other than the displayed one. */
  connectionId?: string;
};

export type PaneJumpConnectionTarget = {
  connectionId: string;
  paneId: string;
};

/** Pane IDs are only unique per server, so remote entries add the server. */
export function paneJumpEntryKey(entry: PaneJumpEntry): string {
  return entry.key;
}

type ActivePaneSnapshot = {
  selectedPaneId?: string | null;
  layout?: Pick<PaneLayout, "panes" | "focused_pane_id"> | null;
};

type PaneJumpSnapshot = {
  layout?: Pick<PaneLayout, "panes"> | null;
  panes: Pane[];
  recentPaneIds: string[];
  tabs: Tab[];
  workspaces: Workspace[];
};

/** Resolves selection only when it still belongs to the active layout. */
export function activePaneIdForSnapshot(
  snapshot: ActivePaneSnapshot,
): string | undefined {
  return snapshot.selectedPaneId &&
    snapshot.layout?.panes.some(
      (pane) => pane.pane_id === snapshot.selectedPaneId,
    )
    ? snapshot.selectedPaneId
    : snapshot.layout?.focused_pane_id;
}

/** A pane can be closed inline only while a sibling keeps its tab alive. */
export function paneCanClose(
  panes: readonly Pick<Pane, "pane_id" | "tab_id">[],
  paneId: string,
): boolean {
  const target = panes.find((pane) => pane.pane_id === paneId);
  return (
    !!target &&
    panes.some(
      (pane) => pane.pane_id !== paneId && pane.tab_id === target.tab_id,
    )
  );
}

/**
 * Panes on the connections that are not displayed, listed after every
 * displayed pane so a browser's own work always leads, in catalog order. Each
 * connection is the same kind of entry as a displayed pane (a real pane with
 * its workspace, tab, cwd, and agent), labelled with its connection. The
 * recent switcher takes one pane per workspace (the one most recently used
 * there, else the focused one) so a connection reads as its workspaces
 * instead of flooding the list; search takes every pane.
 */
function connectionPaneEntries(
  connections: readonly ConnectionSessionView[],
  includeAllPanes: boolean,
): PaneJumpEntry[] {
  const entries: PaneJumpEntry[] = [];
  for (const view of connections) {
    if (view.active) continue;
    const workspaceById = new Map(
      view.workspaces.map((workspace) => [workspace.workspace_id, workspace]),
    );
    const tabById = new Map(view.tabs.map((tab) => [tab.tab_id, tab]));
    const recentRank = new Map(
      view.recentPaneIds.map((paneId, index) => [paneId, index]),
    );
    const workspaceNumber = (pane: Pane) =>
      workspaceById.get(pane.workspace_id)?.number ?? Number.MAX_SAFE_INTEGER;
    const ordered = [...view.panes].sort(
      (left, right) =>
        workspaceNumber(left) - workspaceNumber(right) ||
        (recentRank.get(left.pane_id) ?? Number.MAX_SAFE_INTEGER) -
          (recentRank.get(right.pane_id) ?? Number.MAX_SAFE_INTEGER) ||
        Number(right.focused) - Number(left.focused),
    );
    const seenWorkspaces = new Set<string>();
    for (const pane of ordered) {
      if (!includeAllPanes) {
        if (seenWorkspaces.has(pane.workspace_id)) continue;
        seenWorkspaces.add(pane.workspace_id);
      }
      const entry = paneJumpEntry(pane, workspaceById, tabById, false);
      entries.push({
        ...entry,
        key: `${view.connection.id}:${pane.pane_id}`,
        paneLabel: `${view.connection.label} · ${entry.paneLabel}`,
        connectionId: view.connection.id,
      });
    }
  }
  return entries;
}

/**
 * Projects live pane state into a deduplicated, most-recent-first switcher.
 * `connections` adds the panes of connections that are not displayed (the
 * all-connections view); the displayed one's entry there is ignored.
 */
export function paneJumpEntries(
  snapshot: PaneJumpSnapshot,
  activePaneId?: string | null,
  connections: readonly ConnectionSessionView[] = [],
): PaneJumpEntry[] {
  return [
    ...orderedPaneJumpEntries(snapshot, activePaneId, false),
    ...connectionPaneEntries(connections, false),
  ];
}

/**
 * Searches every live pane instead of the recent ones alone, so a pane that was
 * never visited stays reachable by workspace, tab, directory, or agent name.
 * Matches keep the recent-first order rather than a relevance ranking, which
 * leaves the list stable while the query grows.
 */
export function paneSearchEntries(
  snapshot: PaneJumpSnapshot,
  query: string,
  activePaneId?: string | null,
  connections: readonly ConnectionSessionView[] = [],
  serverLabel?: string,
): PaneJumpEntry[] {
  const entries = orderedPaneJumpEntries(snapshot, activePaneId, true);
  return filterPaneSearchEntries(
    [
      ...(serverLabel
        ? entries.map((entry) => ({ ...entry, serverLabel }))
        : entries),
      ...connectionPaneEntries(connections, true),
    ],
    query,
  );
}

/**
 * Agent panes from the other ready servers, for the same search. The caller
 * passes them already ordered; panes of the active server are skipped because
 * the live snapshot covers them.
 */
export function serverPaneSearchEntries(
  panes: readonly ServerAgentPane[],
  query: string,
  activeConnectionId: string | null | undefined,
): PaneJumpEntry[] {
  return filterPaneSearchEntries(
    panes
      .filter((pane) => pane.connectionId !== activeConnectionId)
      .map((pane) => ({
        key: `${pane.connectionId}:${pane.pane_id}`,
        paneId: pane.pane_id,
        paneLabel: `Pane ${shortId(pane.pane_id)}`,
        title: pane.workspaceLabel,
        tabLabel: pane.tabLabel || pane.tab_id,
        cwd: pane.foreground_cwd ?? pane.cwd ?? "",
        agent: pane.agent,
        agentStatus: pane.agent ? pane.agent_status : undefined,
        current: false,
        serverLabel: pane.serverLabel,
        source: {
          connectionId: pane.connectionId,
          runtimeGeneration: pane.runtimeGeneration,
          serverLabel: pane.serverLabel,
          workspaceId: pane.workspace_id,
        },
      })),
    query,
  );
}

function filterPaneSearchEntries(
  entries: PaneJumpEntry[],
  query: string,
): PaneJumpEntry[] {
  const tokens = normalizeSearchText(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return entries;
  return entries.filter((entry) => {
    const haystack = normalizeSearchText(paneSearchValue(entry));
    return tokens.every((token) => haystack.includes(token));
  });
}

function orderedPaneJumpEntries(
  snapshot: PaneJumpSnapshot,
  activePaneId: string | null | undefined,
  includeAllPanes: boolean,
): PaneJumpEntry[] {
  const paneById = new Map(snapshot.panes.map((pane) => [pane.pane_id, pane]));
  const workspaceById = new Map(
    snapshot.workspaces.map((workspace) => [workspace.workspace_id, workspace]),
  );
  const tabById = new Map(snapshot.tabs.map((tab) => [tab.tab_id, tab]));
  const fallbackPaneIds =
    snapshot.layout?.panes.map((pane) => pane.pane_id) ?? [];
  const seen = new Set<string>();
  const orderedPaneIds = [
    ...snapshot.recentPaneIds,
    ...fallbackPaneIds,
    ...(includeAllPanes ? snapshot.panes.map((pane) => pane.pane_id) : []),
  ];

  return orderedPaneIds
    .filter((paneId) => {
      if (seen.has(paneId)) return false;
      seen.add(paneId);
      return paneById.has(paneId);
    })
    .map((paneId) =>
      paneJumpEntry(
        paneById.get(paneId)!,
        workspaceById,
        tabById,
        paneId === activePaneId,
      ),
    );
}

function paneSearchValue(entry: PaneJumpEntry): string {
  return [
    entry.title,
    entry.serverLabel,
    entry.tabLabel,
    entry.cwd,
    entry.paneLabel,
    entry.agent,
    entry.agentStatus,
    entry.paneId,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Returns a real focus target, excluding an invalid or already-current item. */
export function paneJumpTargetId(
  entries: PaneJumpEntry[],
  index: number,
): string | null {
  const entry = entries[index];
  return entry && !entry.current && !entry.connectionId ? entry.paneId : null;
}

/** Returns the target of an entry on a connection that is not displayed. */
export function paneJumpConnectionTarget(
  entries: PaneJumpEntry[],
  index: number,
): PaneJumpConnectionTarget | null {
  const entry = entries[index];
  return entry?.connectionId
    ? { connectionId: entry.connectionId, paneId: entry.paneId }
    : null;
}

function paneJumpEntry(
  pane: Pane,
  workspaceById: Map<string, Workspace>,
  tabById: Map<string, Tab>,
  current: boolean,
): PaneJumpEntry {
  const workspace = workspaceById.get(pane.workspace_id);
  const tab = tabById.get(pane.tab_id);
  const cwd = pane.foreground_cwd ?? pane.cwd ?? "";
  const workspaceLabel = workspace?.label ?? pane.workspace_id;
  const tabLabel = tab
    ? tab.label && tab.label !== String(tab.number)
      ? tab.label
      : `Tab ${tab.number}`
    : pane.tab_id;

  return {
    key: pane.pane_id,
    paneId: pane.pane_id,
    paneLabel: `Pane ${shortId(pane.pane_id)}`,
    title: workspaceLabel,
    tabLabel,
    cwd,
    agent: pane.agent,
    agentStatus: pane.agent ? pane.agent_status : undefined,
    current,
  };
}
