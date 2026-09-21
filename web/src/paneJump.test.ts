import { describe, expect, test } from "bun:test";
import {
  activePaneIdForSnapshot,
  paneCanClose,
  paneJumpEntries,
  paneJumpTargetId,
  paneSearchEntries,
} from "./paneJump";
import type { Pane, Tab, Workspace } from "./types";

function workspace(workspaceId: string, label: string): Workspace {
  return {
    workspace_id: workspaceId,
    number: 1,
    label,
    focused: false,
    pane_count: 1,
    tab_count: 1,
    agent_status: "unknown",
  };
}

function tab(tabId: string, workspaceId: string): Tab {
  return {
    tab_id: tabId,
    workspace_id: workspaceId,
    number: 1,
    label: "1",
    focused: false,
    pane_count: 1,
    agent_status: "unknown",
  };
}

function pane(
  paneId: string,
  workspaceId: string,
  tabId: string,
  agent?: string,
): Pane {
  return {
    pane_id: paneId,
    terminal_id: `terminal-${paneId}`,
    workspace_id: workspaceId,
    tab_id: tabId,
    focused: false,
    cwd: `/repos/${workspaceId}`,
    agent,
    agent_status: agent ? "working" : "unknown",
    revision: 1,
  };
}

describe("recent pane projection", () => {
  test("falls back from a stale selection to the layout-focused pane", () => {
    const layout = {
      focused_pane_id: "mobile-active",
      panes: [
        {
          pane_id: "mobile-active",
          focused: true,
          rect: { x: 0, y: 0, width: 1, height: 1 },
        },
      ],
    };

    expect(activePaneIdForSnapshot({ selectedPaneId: "stale", layout })).toBe(
      "mobile-active",
    );
    expect(
      activePaneIdForSnapshot({ selectedPaneId: "mobile-active", layout }),
    ).toBe("mobile-active");
  });

  test("only allows inline close when a pane has a sibling in its tab", () => {
    const panes = [
      pane("p1", "w1", "t1"),
      pane("p2", "w1", "t1"),
      pane("p3", "w1", "t2"),
    ];

    expect(paneCanClose(panes, "p1")).toBe(true);
    expect(paneCanClose(panes, "p2")).toBe(true);
    expect(paneCanClose(panes, "p3")).toBe(false);
    expect(paneCanClose(panes, "missing")).toBe(false);
  });

  test("emphasizes the workspace and keeps agent state as metadata", () => {
    const entries = paneJumpEntries(
      {
        layout: {
          panes: [
            {
              pane_id: "p1",
              focused: true,
              rect: { x: 0, y: 0, width: 1, height: 1 },
            },
          ],
        },
        panes: [pane("p1", "w1", "t1", "codex")],
        recentPaneIds: ["p1"],
        tabs: [tab("t1", "w1")],
        workspaces: [workspace("w1", "example-repo")],
      },
      "p1",
    );

    expect(entries).toEqual([
      {
        paneId: "p1",
        paneLabel: "Pane p1",
        title: "example-repo",
        subtitle: "Tab 1 · /repos/w1",
        agent: "codex",
        agentStatus: "working",
        current: true,
      },
    ]);
  });

  test("keeps recent order, removes duplicates, and omits absent agent state", () => {
    const entries = paneJumpEntries({
      layout: {
        panes: [
          {
            pane_id: "p1",
            focused: false,
            rect: { x: 0, y: 0, width: 1, height: 1 },
          },
          {
            pane_id: "p2",
            focused: true,
            rect: { x: 1, y: 0, width: 1, height: 1 },
          },
        ],
      },
      panes: [pane("p1", "w1", "t1"), pane("p2", "w2", "t2")],
      recentPaneIds: ["p2", "p2"],
      tabs: [tab("t1", "w1"), tab("t2", "w2")],
      workspaces: [workspace("w1", "one"), workspace("w2", "two")],
    });

    expect(entries.map((entry) => entry.paneId)).toEqual(["p2", "p1"]);
    expect(entries[0].title).toBe("two");
    expect(entries[0].agent).toBeUndefined();
    expect(entries[0].agentStatus).toBeUndefined();
  });

  test("distinguishes same-tab panes by their existing short IDs in both modes", () => {
    const snapshot = {
      panes: [pane("w1:p1", "w1", "t1"), pane("w1:p2", "w1", "t1")],
      recentPaneIds: ["w1:p1", "w1:p2"],
      tabs: [tab("t1", "w1")],
      workspaces: [workspace("w1", "one")],
    };
    for (const entries of [
      paneJumpEntries(snapshot),
      paneSearchEntries(snapshot, ""),
    ]) {
      expect(entries.map((entry) => entry.paneLabel)).toEqual([
        "Pane p1",
        "Pane p2",
      ]);
      expect(entries.map((entry) => entry.subtitle)).toEqual([
        "Tab 1 · /repos/w1",
        "Tab 1 · /repos/w1",
      ]);
    }
    expect(
      paneSearchEntries(snapshot, "Pane p2").map((entry) => entry.paneId),
    ).toEqual(["w1:p2"]);
  });

  test("does not refocus the pane that is already current", () => {
    const entries = [
      {
        paneId: "current",
        paneLabel: "Pane current",
        title: "one",
        subtitle: "Tab 1",
        current: true,
      },
      {
        paneId: "previous",
        paneLabel: "Pane previous",
        title: "two",
        subtitle: "Tab 1",
        current: false,
      },
    ];

    expect(paneJumpTargetId(entries, 0)).toBeNull();
    expect(paneJumpTargetId(entries, 1)).toBe("previous");
    expect(paneJumpTargetId(entries, 2)).toBeNull();
  });
});

describe("pane search projection", () => {
  const snapshot = {
    layout: {
      panes: [
        {
          pane_id: "p1",
          focused: true,
          rect: { x: 0, y: 0, width: 1, height: 1 },
        },
      ],
    },
    panes: [
      pane("p1", "w1", "t1"),
      pane("p2", "w2", "t2", "codex"),
      pane("p3", "w3", "t3"),
    ],
    recentPaneIds: ["p1"],
    tabs: [tab("t1", "w1"), tab("t2", "w2"), tab("t3", "w3")],
    workspaces: [
      workspace("w1", "roamgate"),
      workspace("w2", "herdr-docs"),
      workspace("w3", "roamgate-site"),
    ],
  };

  test("reaches panes that the recent list never kept", () => {
    expect(
      paneJumpEntries(snapshot, "p1").map((entry) => entry.paneId),
    ).toEqual(["p1"]);
    expect(
      paneSearchEntries(snapshot, "", "p1").map((entry) => entry.paneId),
    ).toEqual(["p1", "p2", "p3"]);
  });

  test("matches workspace, directory, and agent text case-insensitively", () => {
    const ids = (query: string) =>
      paneSearchEntries(snapshot, query, "p1").map((entry) => entry.paneId);

    expect(ids("HERDR")).toEqual(["p2"]);
    expect(ids("codex")).toEqual(["p2"]);
    expect(ids("/repos/w3")).toEqual(["p3"]);
    expect(ids("roamgate")).toEqual(["p1", "p3"]);
    expect(ids("nothing here")).toEqual([]);
  });

  test("requires every token but ignores their order", () => {
    const ids = (query: string) =>
      paneSearchEntries(snapshot, query, "p1").map((entry) => entry.paneId);

    expect(ids("codex herdr")).toEqual(["p2"]);
    expect(ids("codex roamgate")).toEqual([]);
    expect(ids("  tab   herdr  ")).toEqual(["p2"]);
  });

  test("keeps the recent order ahead of the remaining panes", () => {
    const entries = paneSearchEntries(
      { ...snapshot, recentPaneIds: ["p3", "p2"] },
      "",
      "p3",
    );

    expect(entries.map((entry) => entry.paneId)).toEqual(["p3", "p2", "p1"]);
    expect(entries[0].current).toBe(true);
    expect(entries[1].current).toBe(false);
  });
});
