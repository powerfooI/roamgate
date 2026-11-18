import { useMemo } from "react";
import {
  type ConnectionSessionView,
  connectionSessionViews,
} from "../connectionSessions";
import { useShowAllConnections } from "../showAllConnections";
import { shallowEqual, useStoreSelector } from "../store";

/**
 * Every connection's topology, displayed one included, in catalog order. With
 * the "show all connections" view off only the displayed connection is
 * listed, since no other connection is read then.
 */
export function useConnectionSessions(): ConnectionSessionView[] {
  const includeOthers = useShowAllConnections();
  const s = useStoreSelector(
    (state) => ({
      connections: state.connections,
      activeConnectionId: state.activeConnectionId,
      sessionsByConnectionId: state.sessionsByConnectionId,
      workspaces: state.workspaces,
      tabs: state.tabs,
      panes: state.panes,
      recentPaneIds: state.recentPaneIds,
      error: state.error,
      lastRefresh: state.lastRefresh,
    }),
    shallowEqual,
  );
  return useMemo(
    () =>
      connectionSessionViews(
        s.connections,
        s.activeConnectionId,
        s,
        s.sessionsByConnectionId,
        includeOthers,
      ),
    [s, includeOthers],
  );
}
