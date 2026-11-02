import type { HerdrCall } from "../agent/session-types";
import { isRecord, stringValue } from "../agent/session-utils";
import { herdrEventName } from "../utils/herdr-events";

export function isGenericTerminalTitle(raw: string): boolean {
  return (
    !raw.trim() ||
    /^[\w.-]+@[\w.-]+:?\s*.*$/.test(raw) ||
    /^(bash|zsh|sh|fish|csh|tcsh|dash|tmux|screen|agy|antigravity|claude|hermes|codex|pi|omp|kimi|grok|gemini|opencode|cursor)(?:\s+--?\S.*)?$/i.test(
      raw,
    )
  );
}
export interface HerdrPane {
  pane_id: string;
  tab_id: string;
  focused?: boolean;
  agent?: string;
  terminal_title?: string;
  terminal_title_stripped?: string;
}
interface HerdrTab {
  tab_id: string;
  label: string;
  number?: number;
}
export interface TabAutoRenamerOptions {
  herdr: { call: HerdrCall };
  getAgentTitleForPane: (
    paneId: string,
    pane?: HerdrPane,
  ) => Promise<string | null>;
  isEnabled?: () => Promise<boolean>;
  debounceMs?: number;
  pollIntervalMs?: number;
  log?: (message: string) => void;
}
function agentPane(panes: HerdrPane[], tabId: string) {
  const candidates = panes.filter((p) => p.tab_id === tabId && p.agent);
  return candidates.find((p) => p.focused) ?? candidates[0];
}
function defaultLabel(tab: HerdrTab) {
  return (
    !tab.label ||
    (Number.isInteger(tab.number) &&
      Number(tab.number) > 0 &&
      (tab.label === String(tab.number) || tab.label === `Tab ${tab.number}`))
  );
}
export function createTabAutoRenamer(options: TabAutoRenamerOptions) {
  const manualRenames = new Set<string>();
  const applied = new Map<string, string>();
  const pending = new Map<string, string>();
  const enabled = options.isEnabled ?? (async () => true);
  let disposed = false;
  let started = false;
  let revision = 0;
  let queued = false;
  let work: Promise<void> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  function owns(tab: HerdrTab) {
    if (manualRenames.has(tab.tab_id)) return false;
    const previous = applied.get(tab.tab_id);
    if (previous === undefined) return defaultLabel(tab);
    if (tab.label === previous) return true;
    manualRenames.add(tab.tab_id);
    return false;
  }
  async function snapshot() {
    const [tabs, panes] = await Promise.all([
      options.herdr.call("tab.list", {}, 5000),
      options.herdr.call("pane.list", {}, 5000),
    ]);
    return {
      tabs: (isRecord(tabs) && Array.isArray(tabs.tabs)
        ? tabs.tabs
        : []
      ).filter(isRecord) as unknown as HerdrTab[],
      panes: (isRecord(panes) && Array.isArray(panes.panes)
        ? panes.panes
        : []
      ).filter(isRecord) as unknown as HerdrPane[],
    };
  }
  async function evaluate() {
    const expected = revision;
    const current = () => !disposed && expected === revision;
    if (!(await enabled()) || !current()) return;
    const { tabs, panes } = await snapshot();
    for (const tab of tabs) {
      if (!current()) return;
      if (!tab.tab_id || !owns(tab)) continue;
      const pane = agentPane(panes, tab.tab_id);
      if (!pane) continue;
      const { pane_id: paneId, agent } = pane;
      const title = (
        await options.getAgentTitleForPane(pane.pane_id, pane).catch(() => null)
      )?.trim();
      if (!title || !current()) continue;
      // Re-read labels/focus after slow disk or SSH reads. Other clients can edit them.
      const latest = await snapshot();
      const live = latest.tabs.find((t) => t.tab_id === tab.tab_id);
      const active = agentPane(latest.panes, tab.tab_id);
      if (
        !live ||
        !owns(live) ||
        active?.pane_id !== paneId ||
        active.agent !== agent ||
        live.label === title
      )
        continue;
      if (!(await enabled()) || !current() || manualRenames.has(tab.tab_id))
        continue;
      pending.set(tab.tab_id, title);
      try {
        await options.herdr.call(
          "tab.rename",
          { tab_id: tab.tab_id, label: title },
          5000,
          () => {
            if (!current() || manualRenames.has(tab.tab_id))
              throw new Error("Tab auto-rename cancelled");
          },
        );
        // A failed RPC must remain retryable, and a manual rename must keep ownership.
        if (
          !disposed &&
          !manualRenames.has(tab.tab_id) &&
          pending.get(tab.tab_id) === title
        )
          applied.set(tab.tab_id, title);
      } finally {
        pending.delete(tab.tab_id);
      }
    }
  }
  function triggerEvaluation(): Promise<void> {
    if (disposed) return Promise.resolve();
    queued = true;
    if (work) return work;
    work = (async () => {
      while (queued && !disposed) {
        queued = false;
        await evaluate().catch((error) =>
          options.log?.(`Tab auto-renamer: ${error}`),
        );
      }
    })().finally(() => {
      work = null;
    });
    return work;
  }
  function schedule() {
    if (!started || disposed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void triggerEvaluation();
    }, options.debounceMs ?? 500);
  }
  function settingsChanged() {
    revision++;
    schedule();
  }
  return {
    start() {
      if (started || disposed) return;
      started = true;
      if (options.pollIntervalMs)
        pollTimer = setInterval(schedule, options.pollIntervalMs);
      schedule();
    },
    settingsChanged,
    markManualRename(tabId: string, label?: string) {
      // The GUI assigns new tabs a default "Tab N" label through tab.rename.
      if (
        label &&
        /^(?:Tab )?[1-9]\d*$/.test(label) &&
        !applied.has(tabId) &&
        !pending.has(tabId)
      )
        return;
      if (tabId) manualRenames.add(tabId);
    },
    isManuallyRenamed(tabId: string) {
      return manualRenames.has(tabId);
    },
    handleHerdrEvent(event: unknown) {
      if (!isRecord(event)) return;
      const type = (herdrEventName(event) ?? "").replace(/\./g, "_");
      const data = isRecord(event.data) ? event.data : event;
      const tab = isRecord(data.tab) ? data.tab : data;
      const tabId = stringValue(tab.tab_id);
      if (type === "tab_renamed") {
        const label = stringValue(tab.label);
        if (
          label &&
          (label === pending.get(tabId) || label === applied.get(tabId))
        )
          return;
        if (
          tabId &&
          label &&
          (applied.has(tabId) ||
            pending.has(tabId) ||
            !/^(?:Tab )?[1-9]\d*$/.test(label))
        )
          manualRenames.add(tabId);
      }
      if (type === "tab_closed") {
        manualRenames.delete(tabId);
        applied.delete(tabId);
        pending.delete(tabId);
      }
      if (
        /^(pane_|tab_|workspace_)/.test(type) ||
        type === "session_resync_required"
      )
        settingsChanged();
    },
    triggerEvaluation,
    dispose() {
      disposed = true;
      revision++;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (pollTimer) clearInterval(pollTimer);
      manualRenames.clear();
      applied.clear();
    },
  };
}
export type TabAutoRenamer = ReturnType<typeof createTabAutoRenamer>;
