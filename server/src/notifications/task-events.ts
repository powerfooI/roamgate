import { herdrEventName } from "../utils/herdr-events";

export interface TaskEvent {
  kind: "completed" | "blocked";
  workspaceId: string;
  paneId: string;
  tabId?: string;
  workspaceLabel?: string;
  tabLabel?: string;
  agent: string;
}

type Pane = {
  pane_id: string;
  workspace_id: string;
  tab_id?: string;
  agent?: string;
  agent_status: string;
};

function paneInfo(value: unknown): Pane | null {
  if (!value || typeof value !== "object") return null;
  const pane = value as Pane;
  return typeof pane.pane_id === "string" &&
    pane.pane_id.length > 0 &&
    typeof pane.workspace_id === "string" &&
    pane.workspace_id.length > 0 &&
    typeof pane.agent_status === "string"
    ? pane
    : null;
}

/** One tracker per runtime; initial snapshots seed state without notifying. */
export function createTaskEventTracker(notify: (event: TaskEvent) => void) {
  const panes = new Map<string, Pane>();
  let revision = 0;
  let stopped = false;
  function observe(pane: Pane) {
    const previous = panes.get(pane.pane_id);
    panes.set(pane.pane_id, pane);
    if (previous?.agent_status !== "working") return;
    const status = pane.agent_status;
    if (status !== "blocked" && status !== "done" && status !== "idle") return;
    notify({
      kind: status === "blocked" ? "blocked" : "completed",
      workspaceId: pane.workspace_id,
      paneId: pane.pane_id,
      tabId: typeof pane.tab_id === "string" ? pane.tab_id : undefined,
      agent:
        typeof pane.agent === "string"
          ? pane.agent
          : (previous.agent ?? "Agent"),
    });
  }
  return {
    beginPaneList: () => revision,
    reconcilePaneList(result: unknown, startedAt: number) {
      if (stopped || startedAt !== revision) return;
      const listed = (result as { panes?: unknown } | null)?.panes;
      if (!Array.isArray(listed)) return;
      const live = new Set<string>();
      for (const value of listed) {
        const pane = paneInfo(value);
        if (!pane) continue;
        live.add(pane.pane_id);
        observe(pane);
      }
      for (const id of panes.keys()) if (!live.has(id)) panes.delete(id);
    },
    handleHerdrEvent(event: unknown) {
      if (stopped) return;
      const name = herdrEventName(event)?.replaceAll("_", ".");
      const data = (event as { data?: Record<string, unknown> } | null)?.data;
      if (!data || typeof data !== "object") return;
      if (name === "pane.agent.status.changed") {
        const pane = paneInfo(data);
        if (!pane) return;
        revision++;
        observe({ ...panes.get(pane.pane_id), ...pane });
      } else if (name === "pane.closed" || name === "pane.exited") {
        revision++;
        panes.delete(String(data.pane_id));
      } else if (name === "workspace.closed" || name === "tab.closed") {
        revision++;
        for (const [id, pane] of panes) {
          if (
            name === "workspace.closed"
              ? pane.workspace_id === data.workspace_id
              : pane.tab_id === data.tab_id
          )
            panes.delete(id);
        }
      } else if (name === "pane.moved") {
        revision++;
        const previous = panes.get(String(data.previous_pane_id));
        panes.delete(String(data.previous_pane_id));
        const pane = paneInfo(data.pane);
        if (pane) panes.set(pane.pane_id, { ...previous, ...pane });
      }
    },
    stop() {
      stopped = true;
      panes.clear();
    },
  };
}
