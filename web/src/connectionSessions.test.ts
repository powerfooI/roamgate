import { describe, expect, test } from "bun:test";
import type { ConnectionSummary } from "./api";
import {
  connectionSessionViews,
  readableConnections,
  topologyIsStale,
} from "./connectionSessions";
import { parseShowAllConnectionsPreference } from "./showAllConnections";
import type { Workspace } from "./types";

function connection(
  id: string,
  state: ConnectionSummary["state"] = "ready",
  generation = 1,
): ConnectionSummary {
  return {
    id,
    label: id,
    source: "profile",
    is_default: false,
    state,
    generation,
  };
}

function workspace(workspaceId: string): Workspace {
  return {
    workspace_id: workspaceId,
    number: 1,
    label: workspaceId,
    focused: false,
    pane_count: 1,
    tab_count: 1,
    agent_status: "unknown",
  };
}

function topology(workspaceIds: string[], lastRefresh = 1) {
  return {
    workspaces: workspaceIds.map(workspace),
    tabs: [],
    panes: [],
    recentPaneIds: [],
    error: null,
    lastRefresh,
  };
}

describe("readableConnections", () => {
  test("every ready connection except the displayed one", () => {
    expect(
      readableConnections(
        [
          connection("alpha"),
          connection("beta"),
          connection("gamma", "connecting"),
          connection("delta", "error"),
        ],
        "alpha",
      ).map((c) => c.id),
    ).toEqual(["beta"]);
  });
});

describe("topologyIsStale", () => {
  test("a connection never read, or read from a replaced runtime, is stale", () => {
    const beta = connection("beta", "ready", 2);
    expect(topologyIsStale(beta, undefined)).toBe(true);
    expect(
      topologyIsStale(beta, { serverRuntimeGeneration: 2, lastRefresh: 0 }),
    ).toBe(true);
    expect(
      topologyIsStale(beta, { serverRuntimeGeneration: 1, lastRefresh: 5 }),
    ).toBe(true);
    expect(
      topologyIsStale(beta, { serverRuntimeGeneration: 2, lastRefresh: 5 }),
    ).toBe(false);
  });
});

describe("connectionSessionViews", () => {
  const connections = [
    connection("alpha"),
    connection("beta"),
    connection("gamma", "disconnected"),
    connection("delta"),
  ];
  const sessions = {
    beta: topology(["b1", "b2"]),
    delta: topology([], 0),
  };

  test("lists only the displayed connection unless all are shown", () => {
    const views = connectionSessionViews(
      connections,
      "beta",
      topology(["b1"]),
      sessions,
      false,
    );
    expect(views.map((view) => view.connection.id)).toEqual(["beta"]);
    expect(views[0].active).toBe(true);
  });

  test("keeps catalog order whichever connection is displayed, skipping unready ones", () => {
    for (const activeId of ["alpha", "beta", "delta"]) {
      expect(
        connectionSessionViews(
          connections,
          activeId,
          topology(["x"]),
          sessions,
          true,
        ).map((view) => view.connection.id),
      ).toEqual(["alpha", "beta", "delta"]);
    }
  });

  test("the displayed connection comes from the top-level session, others from theirs", () => {
    const views = connectionSessionViews(
      connections,
      "alpha",
      topology(["a1"]),
      sessions,
      true,
    );
    expect(
      views.map((view) => view.workspaces.map((w) => w.workspace_id)),
    ).toEqual([["a1"], ["b1", "b2"], []]);
    // Delta has never been read: it is listed, but not as loaded.
    expect(views.map((view) => view.loaded)).toEqual([true, true, false]);
  });
});

describe("parseShowAllConnectionsPreference", () => {
  test("only the stored all scope enables the preference", () => {
    expect(parseShowAllConnectionsPreference("all")).toBe(true);
    expect(parseShowAllConnectionsPreference("current")).toBe(false);
    expect(parseShowAllConnectionsPreference(null)).toBe(false);
    expect(parseShowAllConnectionsPreference("1")).toBe(false);
  });
});
