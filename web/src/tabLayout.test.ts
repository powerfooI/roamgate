import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearTabLayouts,
  forgetTabLayoutsExcept,
  provisionalTabLayout,
  rememberTabLayout,
  tabLayoutFor,
} from "./tabLayout";
import type { Pane, PaneLayout } from "./types";

function pane(paneId: string, tabId: string): Pane {
  return {
    pane_id: paneId,
    terminal_id: `terminal-${paneId}`,
    workspace_id: "w1",
    tab_id: tabId,
    focused: false,
    cwd: "/repos/w1",
    agent_status: "unknown",
    revision: 1,
  };
}

function layout(tabId: string, paneIds: string[]): PaneLayout {
  return {
    workspace_id: "w1",
    tab_id: tabId,
    zoomed: false,
    area: { x: 0, y: 0, width: 100, height: 40 },
    focused_pane_id: paneIds[0],
    panes: paneIds.map((paneId, index) => ({
      pane_id: paneId,
      focused: index === 0,
      rect: { x: index * 50, y: 0, width: 50, height: 40 },
    })),
    splits: [],
  };
}

describe("tab layout cache", () => {
  beforeEach(clearTabLayouts);

  test("keeps one entry per tab within a connection generation", () => {
    rememberTabLayout("c1", 1, layout("t1", ["p1"]));
    rememberTabLayout("c1", 2, layout("t1", ["p2"]));

    expect(tabLayoutFor("c1", 1, "t1")?.panes[0].pane_id).toBe("p1");
    expect(tabLayoutFor("c1", 2, "t1")?.panes[0].pane_id).toBe("p2");
    expect(tabLayoutFor("c2", 1, "t1")).toBeNull();
    expect(tabLayoutFor("c1", 1, undefined)).toBeNull();
  });

  test("drops tabs that a refresh no longer reports", () => {
    rememberTabLayout("c1", 1, layout("t1", ["p1"]));
    rememberTabLayout("c1", 1, layout("t2", ["p2"]));
    rememberTabLayout("c2", 1, layout("t2", ["p3"]));

    forgetTabLayoutsExcept("c1", 1, new Set(["t1"]));

    expect(tabLayoutFor("c1", 1, "t1")).not.toBeNull();
    expect(tabLayoutFor("c1", 1, "t2")).toBeNull();
    expect(tabLayoutFor("c2", 1, "t2")).not.toBeNull();
  });
});

describe("provisional tab layout", () => {
  test("reuses cached geometry while the tab holds the same panes", () => {
    const cached = layout("t1", ["p1", "p2"]);
    const panes = [pane("p2", "t1"), pane("p1", "t1")];

    expect(provisionalTabLayout(cached, panes, "t1")).toBe(cached);
  });

  test("rejects cached geometry once the tab gained or lost a pane", () => {
    const cached = layout("t1", ["p1", "p2"]);

    expect(
      provisionalTabLayout(
        cached,
        [pane("p1", "t1"), pane("p2", "t1"), pane("p3", "t1")],
        "t1",
      ),
    ).toBeNull();
    expect(
      provisionalTabLayout(cached, [pane("p1", "t1")], "t1"),
    ).not.toBeNull();
    expect(
      provisionalTabLayout(cached, [pane("p1", "t1")], "t1")?.panes,
    ).toEqual([
      {
        pane_id: "p1",
        focused: true,
        rect: { x: 0, y: 0, width: 1, height: 1 },
      },
    ]);
  });

  test("fills the tab with its only pane when nothing is cached", () => {
    const projected = provisionalTabLayout(
      null,
      [pane("p1", "t1"), pane("p9", "t2")],
      "t1",
    );

    expect(projected).toEqual({
      workspace_id: "w1",
      tab_id: "t1",
      zoomed: false,
      area: { x: 0, y: 0, width: 1, height: 1 },
      focused_pane_id: "p1",
      panes: [
        {
          pane_id: "p1",
          focused: true,
          rect: { x: 0, y: 0, width: 1, height: 1 },
        },
      ],
      splits: [],
    });
  });

  test("guesses nothing for an unvisited split or an empty tab", () => {
    expect(
      provisionalTabLayout(null, [pane("p1", "t1"), pane("p2", "t1")], "t1"),
    ).toBeNull();
    expect(provisionalTabLayout(null, [pane("p1", "t1")], "t2")).toBeNull();
    expect(
      provisionalTabLayout(null, [pane("p1", "t1")], undefined),
    ).toBeNull();
    expect(
      provisionalTabLayout(layout("t2", ["p1"]), [pane("p1", "t1")], "t1"),
    ).not.toBeNull();
  });
});
