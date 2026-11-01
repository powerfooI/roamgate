import { isRecord, stringValue } from "../agent/session-utils";

export function isGenericTerminalTitle(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  // Match shell prompt like user@host: path or user@host path
  if (/^[\w.-]+@[\w.-]+:?\s*.*$/.test(trimmed)) return true;
  // Match common shell binaries
  if (/^(bash|zsh|sh|fish|csh|tcsh|dash|tmux|screen)$/i.test(trimmed))
    return true;
  // Match CLI invocations like "agy --...", "claude --...", "hermes ..."
  if (/^(agy|claude|hermes|codex)\s+--?[a-zA-Z0-9_-]+/i.test(trimmed))
    return true;
  return false;
}

export interface HerdrPane {
  pane_id: string;
  tab_id: string;
  focused?: boolean;
  agent?: string;
  cwd?: string;
  terminal_title?: string;
  terminal_title_stripped?: string;
}

export interface TabAutoRenamerOptions {
  herdr: {
    call(
      method: string,
      params?: Record<string, unknown>,
      timeoutMs?: number,
    ): Promise<any>;
  };
  getAgentTitleForPane: (
    paneId: string,
    candidatePane?: HerdrPane,
  ) => Promise<string | null>;
  isEnabled?: () => Promise<boolean>;
  debounceMs?: number;
  pollIntervalMs?: number;
  log?: (message: string) => void;
}

export interface TabAutoRenamer {
  markManualRename(tabId: string): void;
  isManuallyRenamed(tabId: string): boolean;
  handleHerdrEvent(event: unknown): void;
  triggerEvaluation(paneId?: string): Promise<void>;
  dispose(): void;
}

interface HerdrTab {
  tab_id: string;
  label: string;
  number?: number;
  workspace_id?: string;
}

export function createTabAutoRenamer(
  options: TabAutoRenamerOptions,
): TabAutoRenamer {
  const manualRenames = new Set<string>();
  const lastAppliedTitles = new Map<string, string>();
  const debounceMs = options.debounceMs ?? 500;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  const isEnabled = options.isEnabled ?? (async () => true);

  async function evaluate() {
    if (disposed) return;
    const enabled = await isEnabled().catch(() => false);
    if (!enabled || disposed) return;

    try {
      const [tabsResult, panesResult] = await Promise.all([
        options.herdr.call("tab.list", {}, 5000),
        options.herdr.call("pane.list", {}, 5000),
      ]);

      const tabs: HerdrTab[] = Array.isArray(tabsResult?.tabs)
        ? tabsResult.tabs
        : [];
      const panes: HerdrPane[] = Array.isArray(panesResult?.panes)
        ? panesResult.panes
        : [];

      for (const tab of tabs) {
        if (!tab.tab_id || manualRenames.has(tab.tab_id)) continue;

        const tabPanes = panes.filter((p) => p.tab_id === tab.tab_id);
        if (tabPanes.length === 0) continue;

        // Prioritize focused pane if it has an agent, else first pane with an agent
        const focusedAgentPane = tabPanes.find((p) => p.focused && p.agent);
        const candidatePane =
          focusedAgentPane ?? tabPanes.find((p) => Boolean(p.agent));

        if (!candidatePane) continue;

        const title = await options
          .getAgentTitleForPane(candidatePane.pane_id, candidatePane)
          .catch(() => null);

        if (!title || typeof title !== "string") continue;
        const trimmed = title.trim();
        if (!trimmed) continue;

        // If tab already has this label or we already applied this title, skip
        if (
          tab.label === trimmed ||
          lastAppliedTitles.get(tab.tab_id) === trimmed
        ) {
          continue;
        }

        lastAppliedTitles.set(tab.tab_id, trimmed);
        await options.herdr
          .call("tab.rename", { tab_id: tab.tab_id, label: trimmed }, 5000)
          .catch((err) => {
            options.log?.(`Failed to auto-rename tab ${tab.tab_id}: ${err}`);
          });
      }
    } catch (error) {
      options.log?.(`Tab auto-renamer evaluation error: ${error}`);
    }
  }

  function scheduleEvaluation() {
    if (disposed) return;
    if (debounceMs <= 0) {
      evaluate().catch(() => {});
      return;
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      evaluate().catch(() => {});
    }, debounceMs);
  }

  if (options.pollIntervalMs && options.pollIntervalMs > 0) {
    pollTimer = setInterval(() => {
      scheduleEvaluation();
    }, options.pollIntervalMs);
  }

  // Initial evaluation on startup
  scheduleEvaluation();

  return {
    markManualRename(tabId: string) {
      if (tabId) manualRenames.add(tabId);
    },

    isManuallyRenamed(tabId: string) {
      return manualRenames.has(tabId);
    },

    handleHerdrEvent(rawEvent: unknown) {
      if (!isRecord(rawEvent)) return;
      const eventType = stringValue(rawEvent.event);
      const data = isRecord(rawEvent.data) ? rawEvent.data : rawEvent;

      if (eventType === "tab.closed" || eventType === "tab_closed") {
        const tabId = stringValue(data.tab_id);
        if (tabId) {
          manualRenames.delete(tabId);
          lastAppliedTitles.delete(tabId);
        }
      } else if (
        eventType === "pane.agent_detected" ||
        eventType === "pane_agent_detected" ||
        eventType === "pane.agent_status_changed" ||
        eventType === "pane_agent_status_changed" ||
        eventType === "pane.focused" ||
        eventType === "pane_focused" ||
        eventType === "tab.focused" ||
        eventType === "tab_focused" ||
        eventType === "session.resync_required"
      ) {
        scheduleEvaluation();
      }
    },

    async triggerEvaluation() {
      await evaluate();
    },

    dispose() {
      disposed = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      manualRenames.clear();
      lastAppliedTitles.clear();
    },
  };
}
