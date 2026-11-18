import type { ConnectionSummary } from "./api";
import type { ServerSessionState } from "./store";
import type { Pane, Tab, Workspace } from "./types";

/**
 * One connection's topology as every view reads it, whichever connection is
 * displayed. The displayed (active) connection is not special here: its
 * session comes from the store's top-level fields instead of
 * `sessionsByConnectionId`, and only it owns layout, selection, and the
 * terminal, but the tree and the pane switchers render all of them alike.
 */
export type ConnectionSessionView = {
  connection: ConnectionSummary;
  active: boolean;
  workspaces: Workspace[];
  tabs: Tab[];
  panes: Pane[];
  recentPaneIds: string[];
  error: string | null;
  /** False until the connection's topology has been read at least once. */
  loaded: boolean;
};

type SessionTopology = Pick<
  ServerSessionState,
  "workspaces" | "tabs" | "panes" | "recentPaneIds" | "error" | "lastRefresh"
>;

/**
 * Connections whose topology is read besides the displayed one: every other
 * connection that is ready. A connecting/disconnected/error connection has no
 * topology to read; it is surfaced through the connection switcher instead.
 */
export function readableConnections(
  connections: readonly ConnectionSummary[],
  activeConnectionId: string,
): ConnectionSummary[] {
  return connections.filter(
    (connection) =>
      connection.id !== activeConnectionId && connection.state === "ready",
  );
}

/**
 * Whether a connection's stored session no longer describes its current
 * runtime: never read, or read from a runtime the connection has since
 * replaced (a reconnect bumps the generation and invalidates the session).
 */
export function topologyIsStale(
  connection: ConnectionSummary,
  session:
    | Pick<ServerSessionState, "serverRuntimeGeneration" | "lastRefresh">
    | undefined,
): boolean {
  return (
    !session ||
    session.lastRefresh === 0 ||
    session.serverRuntimeGeneration !== connection.generation
  );
}

/**
 * Every connection's topology in catalog order. The active connection is
 * always listed; the others only with `includeOthers` (the "show all
 * connections" view), and only while ready. Catalog order, never "active
 * first": selecting a workspace on another connection makes it active, and
 * reordering on that would shuffle every group under the pointer that just
 * clicked.
 */
export function connectionSessionViews(
  connections: readonly ConnectionSummary[],
  activeConnectionId: string,
  activeSession: SessionTopology,
  sessions: Readonly<Record<string, SessionTopology>>,
  includeOthers: boolean,
): ConnectionSessionView[] {
  const readable = new Set(
    includeOthers
      ? readableConnections(connections, activeConnectionId).map(
          (connection) => connection.id,
        )
      : [],
  );
  const views: ConnectionSessionView[] = [];
  for (const connection of connections) {
    const active = connection.id === activeConnectionId;
    if (!active && !readable.has(connection.id)) continue;
    const session = active ? activeSession : sessions[connection.id];
    views.push({
      connection,
      active,
      workspaces: session?.workspaces ?? [],
      tabs: session?.tabs ?? [],
      panes: session?.panes ?? [],
      recentPaneIds: session?.recentPaneIds ?? [],
      error: session?.error ?? null,
      loaded: active || (!!session && session.lastRefresh > 0),
    });
  }
  return views;
}
