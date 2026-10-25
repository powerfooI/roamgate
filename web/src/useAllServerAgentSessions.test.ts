import { expect, spyOn, test } from "bun:test";
import type { ConnectionSummary } from "./api";
import { groupOrderedAgentPanes, sortAgentPanes } from "./agentOrder";
import {
  allServerAgentPanes,
  type ConnectionAgentSessions,
  openServerSession,
} from "./useAllServerAgentSessions";
import { __storeTesting, store } from "./store";

function agentSnapshot(id: string, generation = 1): ConnectionAgentSessions {
  return {
    connection_id: id,
    connection_generation: generation,
    workspaces: [
      {
        workspace_id: "w1",
        number: 1,
        label: `${id} workspace`,
        focused: true,
        pane_count: 1,
        tab_count: 1,
        agent_status: "working",
      },
    ],
    tabs: [
      {
        tab_id: "t1",
        workspace_id: "w1",
        number: 1,
        label: `${id} tab`,
        focused: true,
        pane_count: 1,
        agent_status: "working",
      },
    ],
    panes: [
      {
        pane_id: "w1:p1",
        workspace_id: "w1",
        tab_id: "t1",
        terminal_id: "term1",
        agent: "codex",
        agent_status: "working",
        focused: true,
        revision: 1,
      },
    ],
    agents: null,
  };
}

test("keeps overlapping server IDs separate through sorting and workspace grouping", () => {
  const connections: ConnectionSummary[] = ["alpha", "beta"].map((id) => ({
    id,
    label: id,
    source: "test",
    is_default: id === "alpha",
    state: "ready",
    generation: 1,
  }));
  const panes = allServerAgentPanes(
    connections,
    connections.map(({ id }) => agentSnapshot(id)),
  );
  expect(panes.map((pane) => pane.connectionId)).toEqual(["alpha", "beta"]);
  expect(panes.map((pane) => pane.tabLabel)).toEqual(["alpha tab", "beta tab"]);
  const sorted = sortAgentPanes(panes, [], "attention");
  expect(sorted).toHaveLength(2);
  const groups = groupOrderedAgentPanes(
    sorted,
    "workspace",
    new Map(panes.map((pane) => [pane.workspaceKey, pane.workspaceLabel])),
  );
  expect(groups.map((group) => group.label)).toEqual([
    "alpha workspace",
    "beta workspace",
  ]);
  expect(new Set(groups.map((group) => group.key)).size).toBe(2);
});

test("all-server attention order uses durable activity across overlapping server IDs", () => {
  const connections: ConnectionSummary[] = ["alpha", "beta"].map((id) => ({
    id,
    label: id,
    source: "test",
    is_default: id === "alpha",
    state: "ready",
    generation: 1,
  }));
  const snapshots = connections.map(({ id }, index) => {
    const snapshot = agentSnapshot(id);
    snapshot.panes[0].agent_status = "idle";
    snapshot.agents = {
      agents: [
        {
          pane_id: "w1:p1",
          terminal_id: "term1",
          agent: "codex",
          agent_status: "idle",
          state_change_seq: index === 0 ? 999 : 1,
          last_activity_at: index === 0 ? 1000 : 2000,
        },
      ],
    };
    return snapshot;
  });
  const ordered = sortAgentPanes(
    allServerAgentPanes(connections, snapshots),
    [],
    "attention",
  );
  expect(ordered.map(({ connectionId }) => connectionId)).toEqual([
    "beta",
    "alpha",
  ]);
});

test("hides failed, disconnected, and replaced runtime snapshots", () => {
  const connection: ConnectionSummary = {
    id: "alpha",
    label: "alpha",
    source: "test",
    is_default: true,
    state: "ready",
    generation: 2,
  };
  expect(
    allServerAgentPanes([connection], [agentSnapshot("alpha", 1)]),
  ).toEqual([]);
  expect(
    allServerAgentPanes(
      [{ ...connection, state: "disconnected" }],
      [agentSnapshot("alpha", 2)],
    ),
  ).toEqual([]);
  expect(
    allServerAgentPanes(
      [connection],
      [{ ...agentSnapshot("alpha", 2), error: "failed" }],
    ),
  ).toEqual([]);
  const snapshot = agentSnapshot("alpha", 2);
  snapshot.panes.push({ ...snapshot.panes[0], pane_id: "shell", agent: "" });
  snapshot.tabs[0].workspace_id = "another-workspace";
  const [pane] = allServerAgentPanes([connection], [snapshot]);
  expect(pane.tabLabel).toBe("");
  expect(allServerAgentPanes([connection], [snapshot])).toHaveLength(1);
});

test("source navigation refuses replaced or disconnected servers before switching", async () => {
  const previous = store.get();
  const navigate = spyOn(store, "focusWorkspaceSource").mockResolvedValue(true);
  const source = {
    connectionId: "alpha",
    runtimeGeneration: 2,
    serverLabel: "Alpha",
  };
  try {
    __storeTesting.replaceState({
      ...previous,
      connections: [
        {
          id: "alpha",
          label: "Alpha",
          source: "test",
          is_default: true,
          generation: 2,
          state: "ready",
        },
      ],
    });
    expect(await openServerSession(source, "w1", "w1:p1")).toBe(true);
    expect(navigate).toHaveBeenLastCalledWith({
      connectionId: "alpha",
      runtimeGeneration: 2,
      workspaceId: "w1",
      paneId: "w1:p1",
    });
    expect(
      await openServerSession({ ...source, runtimeGeneration: 1 }, "w1"),
    ).toBe(false);
    __storeTesting.replaceState({
      ...store.get(),
      connections: store.get().connections.map((connection) => ({
        ...connection,
        state: "disconnected",
      })),
    });
    expect(await openServerSession(source, "w1")).toBe(false);
    expect(navigate).toHaveBeenCalledTimes(1);
  } finally {
    navigate.mockRestore();
    __storeTesting.replaceState(previous);
  }
});
