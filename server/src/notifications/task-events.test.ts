import { expect, test } from "bun:test";
import { createTaskEventTracker, type TaskEvent } from "./task-events";

const pane = {
  pane_id: "p1",
  workspace_id: "w1",
  tab_id: "t1",
  agent: "Example agent",
  agent_status: "working",
};
const event = (status: string) => ({
  event: "pane.agent_status_changed",
  data: { ...pane, agent_status: status },
});

test("initial snapshots seed, transitions notify once, and stale snapshots cannot replay events", () => {
  const events: TaskEvent[] = [];
  const tracker = createTaskEventTracker((task) => events.push(task));
  tracker.reconcilePaneList({ panes: [pane] }, tracker.beginPaneList());
  expect(events).toEqual([]);
  const revision = tracker.beginPaneList();
  tracker.handleHerdrEvent(event("blocked"));
  tracker.handleHerdrEvent(event("blocked"));
  tracker.reconcilePaneList({ panes: [pane] }, revision);
  tracker.handleHerdrEvent(event("idle"));
  expect(events.map((task) => task.kind)).toEqual(["blocked"]);
  tracker.handleHerdrEvent(event("working"));
  tracker.reconcilePaneList(
    { panes: [{ ...pane, agent_status: "done" }] },
    tracker.beginPaneList(),
  );
  tracker.handleHerdrEvent(event("idle"));
  expect(events.map((task) => task.kind)).toEqual(["blocked", "completed"]);
  expect(events[0]).toMatchObject({
    paneId: "p1",
    workspaceId: "w1",
    tabId: "t1",
    agent: "Example agent",
  });
});

test("partial status events retain the tab from the pane snapshot", () => {
  const events: TaskEvent[] = [];
  const tracker = createTaskEventTracker((task) => events.push(task));
  tracker.reconcilePaneList({ panes: [pane] }, 0);
  tracker.handleHerdrEvent({
    event: "pane.agent_status_changed",
    data: { pane_id: "p1", workspace_id: "w1", agent_status: "done" },
  });
  expect(events[0]).toMatchObject({ tabId: "t1", agent: "Example agent" });
});

test("moves, closures, malformed lists and stopped runtimes do not fabricate tasks", () => {
  const events: TaskEvent[] = [];
  const tracker = createTaskEventTracker((task) => events.push(task));
  tracker.reconcilePaneList({ panes: [pane] }, 0);
  tracker.reconcilePaneList({}, 0);
  tracker.handleHerdrEvent({
    event: "pane_moved",
    data: {
      previous_pane_id: "p1",
      pane: { ...pane, pane_id: "p2", workspace_id: "w2" },
    },
  });
  tracker.handleHerdrEvent({
    event: "pane_agent_status_changed",
    data: {
      ...pane,
      pane_id: "p2",
      workspace_id: "w2",
      agent_status: "blocked",
    },
  });
  expect(events[0]).toMatchObject({ paneId: "p2", workspaceId: "w2" });
  tracker.handleHerdrEvent(event("idle"));
  expect(events).toHaveLength(1);
  tracker.handleHerdrEvent(event("working"));
  tracker.handleHerdrEvent({
    event: "workspace.closed",
    data: { workspace_id: "w1" },
  });
  tracker.handleHerdrEvent(event("done"));
  expect(events).toHaveLength(1);
  tracker.stop();
  tracker.handleHerdrEvent(event("working"));
  tracker.handleHerdrEvent(event("blocked"));
  tracker.reconcilePaneList({ panes: [pane] }, tracker.beginPaneList());
  expect(events).toHaveLength(1);
});
