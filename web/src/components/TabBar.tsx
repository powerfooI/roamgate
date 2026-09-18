import { shortcutTitle, useShortcutPreferences } from "../shortcutPreferences";
import {
  shallowEqual,
  store,
  useStoreSelector,
  useEndpointCreationReason,
} from "../store";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MessageSquareText, PanelRight } from "lucide-react";
import type { Tab } from "../types";
import { AgentStatusIcon } from "./AgentStatusIcon";
import { ConfirmDialog, TextInputDialog } from "./ModalDialogs";
import {
  clearTerminalComposerDrafts,
  terminalComposerCloseWarning,
  terminalComposerDraftPaneIds,
} from "../terminalComposer";
import { summarizeTabAgents } from "./agentSession";
import "./TabBar.css";

const LONG_PRESS_MS = 550;
const LONG_PRESS_MOVE_PX = 10;
const REQUEST_CLOSE_TAB_EVENT = "roamgate:request-close-tab";
const REQUEST_CLOSE_PANE_EVENT = "roamgate:request-close-pane";

interface TabMenuState {
  tab: Tab;
  x: number;
  y: number;
}

export function tabName(tab?: Tab) {
  if (!tab) return "";
  return tab.label && tab.label !== String(tab.number)
    ? tab.label
    : `Tab ${tab.number}`;
}

/**
 * Routes non-TabBar close controls through the same confirmation dialog used
 * by the tab strip, so keyboard shortcuts cannot bypass destructive-action UX.
 */
export function requestCloseTab(tabId: string) {
  window.dispatchEvent(
    new CustomEvent(REQUEST_CLOSE_TAB_EVENT, { detail: { tabId } }),
  );
}

/** Routes pane shortcuts through confirmation even when terminals are hidden. */
export function requestClosePane(paneId: string) {
  window.dispatchEvent(
    new CustomEvent(REQUEST_CLOSE_PANE_EVENT, { detail: { paneId } }),
  );
}

/**
 * Tab strip for the focused workspace, with create (+) and close (×) controls.
 * Desktop keeps the strip visible even with one tab, while mobile hides it when
 * there is no real tab choice to save vertical terminal space.
 */
export function TabBar({
  mobile = false,
  inspectorOpen = false,
  annotationsOpen = false,
  annotationCount = 0,
  onToggleInspector,
  onToggleAnnotations,
}: {
  mobile?: boolean;
  inspectorOpen?: boolean;
  annotationsOpen?: boolean;
  annotationCount?: number;
  onToggleInspector?: () => void;
  onToggleAnnotations?: () => void;
}) {
  useShortcutPreferences();
  const s = useStoreSelector(
    (state) => ({
      activeConnectionId: state.activeConnectionId,
      connectionGeneration: state.connectionGeneration,
      panes: state.panes,
      tabs: state.tabs,
      workspaces: state.workspaces,
    }),
    shallowEqual,
  );
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(
    null,
  );
  const [pendingClosePaneId, setPendingClosePaneId] = useState<string | null>(
    null,
  );
  const [pendingRenameTab, setPendingRenameTab] = useState<Tab | null>(null);
  const [menu, setMenu] = useState<TabMenuState | null>(null);
  const focusedWs = s.workspaces.find((w) => w.focused);
  const createReason = useEndpointCreationReason(
    "tab.create",
    focusedWs?.workspace_id,
  );
  const tabs = s.tabs
    .filter((t) => t.workspace_id === focusedWs?.workspace_id)
    .sort((a, b) => a.number - b.number);
  const pendingCloseTab = s.tabs.find((t) => t.tab_id === pendingCloseTabId);
  const pendingCloseTabName = tabName(pendingCloseTab);
  const pendingCloseTabPaneIds = s.panes
    .filter((pane) => pane.tab_id === pendingCloseTabId)
    .map((pane) => pane.pane_id);
  const pendingCloseDraftWarning = terminalComposerCloseWarning(
    terminalComposerDraftPaneIds(
      s.activeConnectionId,
      s.connectionGeneration,
      pendingCloseTabPaneIds,
    ).length,
  );
  const pendingClosePane = s.panes.find(
    (pane) => pane.pane_id === pendingClosePaneId,
  );
  const pendingClosePaneDraftWarning = terminalComposerCloseWarning(
    terminalComposerDraftPaneIds(
      s.activeConnectionId,
      s.connectionGeneration,
      pendingClosePane ? [pendingClosePane.pane_id] : [],
    ).length,
  );
  const showTabStrip = !!focusedWs && (!mobile || tabs.length > 1);
  const gitStatus = focusedWs?.worktree?.git_status;
  const changedCount = gitStatus
    ? gitStatus.staged +
      gitStatus.unstaged +
      gitStatus.untracked +
      gitStatus.conflicted
    : 0;

  useEffect(() => {
    const onRequestClose = (event: Event) => {
      const tabId = (event as CustomEvent<{ tabId?: unknown }>).detail?.tabId;
      if (typeof tabId === "string" && tabId) setPendingCloseTabId(tabId);
    };
    const onRequestClosePane = (event: Event) => {
      const paneId = (event as CustomEvent<{ paneId?: unknown }>).detail
        ?.paneId;
      if (typeof paneId === "string" && paneId) setPendingClosePaneId(paneId);
    };
    window.addEventListener(REQUEST_CLOSE_TAB_EVENT, onRequestClose);
    window.addEventListener(REQUEST_CLOSE_PANE_EVENT, onRequestClosePane);
    return () => {
      window.removeEventListener(REQUEST_CLOSE_TAB_EVENT, onRequestClose);
      window.removeEventListener(REQUEST_CLOSE_PANE_EVENT, onRequestClosePane);
    };
  }, []);

  if (!focusedWs) return null;

  const overlays = (
    <>
      <TabContextMenu
        state={menu}
        onClose={() => setMenu(null)}
        onFocus={(tab) => {
          store.focusTab(tab.tab_id);
        }}
        onRename={(tab) => setPendingRenameTab(tab)}
        onCloseTab={(tab) => setPendingCloseTabId(tab.tab_id)}
        createReason={createReason}
        onCreateTab={() => {
          store.createTab(focusedWs.workspace_id);
        }}
      />
      <ConfirmDialog
        open={!!pendingCloseTabId}
        title="Close Tab"
        message={`${
          pendingCloseTabName
            ? `Close "${pendingCloseTabName}"?`
            : "Close this tab?"
        }${pendingCloseDraftWarning}`}
        confirmLabel="Close"
        danger
        onClose={() => setPendingCloseTabId(null)}
        onConfirm={() => {
          if (pendingCloseTabId) {
            clearTerminalComposerDrafts(
              s.activeConnectionId,
              s.connectionGeneration,
              pendingCloseTabPaneIds,
            );
            store.closeTab(pendingCloseTabId);
          }
        }}
      />
      <ConfirmDialog
        open={!!pendingClosePane}
        title="Close Pane"
        message={`Close this terminal pane?${pendingClosePaneDraftWarning}`}
        confirmLabel="Close"
        danger
        onClose={() => setPendingClosePaneId(null)}
        onConfirm={() => {
          if (!pendingClosePane) return;
          clearTerminalComposerDrafts(
            s.activeConnectionId,
            s.connectionGeneration,
            [pendingClosePane.pane_id],
          );
          store.closePane(pendingClosePane.pane_id);
        }}
      />
      <TextInputDialog
        open={!!pendingRenameTab}
        title="Rename Tab"
        label="Name"
        initialValue={tabName(pendingRenameTab ?? undefined)}
        submitLabel="Rename"
        onClose={() => setPendingRenameTab(null)}
        onSubmit={(label) => {
          const value = label.trim();
          if (pendingRenameTab && value) {
            store.renameTab(pendingRenameTab.tab_id, value);
          }
          setPendingRenameTab(null);
        }}
      />
    </>
  );

  return (
    <>
      {showTabStrip ? (
        <div className="tabbar">
          {tabs.map((t) => {
            const name =
              t.label && t.label !== String(t.number)
                ? t.label
                : `Tab ${t.number}`;
            const agentSummary = summarizeTabAgents(s.panes, t.tab_id);
            return (
              <div
                key={t.tab_id}
                className={`tabbar-tab ${t.focused ? "is-active" : ""}`}
                onClick={() => {
                  store.focusTab(t.tab_id);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ tab: t, x: e.clientX, y: e.clientY });
                }}
                title={t.tab_id}
              >
                {agentSummary ? (
                  <span
                    className="tabbar-agent-marker"
                    title={`${agentSummary.primaryAgent} · ${agentSummary.status}${
                      agentSummary.additionalAgents > 0
                        ? ` · ${agentSummary.additionalAgents} more agent${
                            agentSummary.additionalAgents === 1 ? "" : "s"
                          }`
                        : ""
                    }`}
                    aria-label={`${agentSummary.primaryAgent}, status ${agentSummary.status}`}
                  >
                    <AgentStatusIcon
                      agent={agentSummary.primaryAgent}
                      status={agentSummary.status}
                    />
                    {agentSummary.additionalAgents > 0 ? (
                      <span className="tabbar-agent-more">
                        +{agentSummary.additionalAgents}
                      </span>
                    ) : null}
                  </span>
                ) : null}
                <TabLongPressTarget
                  tab={t}
                  onOpenMenu={(x, y) => setMenu({ tab: t, x, y })}
                >
                  <span className="tabbar-name">{name}</span>
                </TabLongPressTarget>
                <button
                  className="tabbar-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPendingCloseTabId(t.tab_id);
                  }}
                  title="Close tab"
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            className="tabbar-add"
            onClick={() => {
              store.createTab(focusedWs.workspace_id);
            }}
            disabled={!!createReason}
            title={createReason ?? shortcutTitle("New tab", "tab.create")}
          >
            +
          </button>
          <span className="tabbar-spacer" />
          <div className="tabbar-utilities">
            <button
              type="button"
              className={inspectorOpen ? "is-active" : ""}
              aria-expanded={inspectorOpen}
              title={shortcutTitle(
                inspectorOpen
                  ? "Close Workspace Inspector"
                  : "Open Workspace Inspector",
                "inspector.toggle",
              )}
              onClick={onToggleInspector}
            >
              <PanelRight size={14} />
              <span>Inspector</span>
              {changedCount > 0 ? (
                <span className="tabbar-change-count">{changedCount}</span>
              ) : null}
            </button>
            <button
              type="button"
              className={annotationsOpen ? "is-active" : ""}
              aria-expanded={annotationsOpen}
              title={shortcutTitle(
                annotationsOpen ? "Close Annotations" : "Open Annotations",
                "annotations.toggle",
              )}
              onClick={onToggleAnnotations}
            >
              <MessageSquareText size={14} />
              <span>Annotations</span>
              {annotationCount > 0 ? (
                <span className="tabbar-change-count">{annotationCount}</span>
              ) : null}
            </button>
          </div>
        </div>
      ) : null}
      {createPortal(overlays, document.body)}
    </>
  );
}

function TabLongPressTarget({
  tab,
  children,
  onOpenMenu,
}: {
  tab: Tab;
  children: React.ReactNode;
  onOpenMenu: (x: number, y: number) => void;
}) {
  // Touch long-press opens the same menu as desktop right-click.
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStart = useRef<{ x: number; y: number } | null>(null);
  const longPressTriggered = useRef(false);

  const clearLongPressTimer = () => {
    if (!longPressTimer.current) return;
    clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };

  useEffect(() => clearLongPressTimer, []);

  return (
    <span
      className="tabbar-name-hit"
      onClick={(e) => {
        if (!longPressTriggered.current) return;
        longPressTriggered.current = false;
        e.preventDefault();
        e.stopPropagation();
      }}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse") return;
        longPressTriggered.current = false;
        longPressStart.current = { x: e.clientX, y: e.clientY };
        clearLongPressTimer();
        longPressTimer.current = setTimeout(() => {
          longPressTriggered.current = true;
          onOpenMenu(e.clientX, e.clientY);
        }, LONG_PRESS_MS);
      }}
      onPointerMove={(e) => {
        const start = longPressStart.current;
        if (!start) return;
        const dx = Math.abs(e.clientX - start.x);
        const dy = Math.abs(e.clientY - start.y);
        if (dx > LONG_PRESS_MOVE_PX || dy > LONG_PRESS_MOVE_PX) {
          clearLongPressTimer();
          longPressStart.current = null;
        }
      }}
      onPointerUp={clearLongPressTimer}
      onPointerCancel={clearLongPressTimer}
      onPointerLeave={clearLongPressTimer}
      title={tab.tab_id}
    >
      {children}
    </span>
  );
}

function TabContextMenu({
  state,
  onClose,
  onFocus,
  onRename,
  onCloseTab,
  onCreateTab,
  createReason,
}: {
  state: TabMenuState | null;
  onClose: () => void;
  onFocus: (tab: Tab) => void;
  onRename: (tab: Tab) => void;
  onCloseTab: (tab: Tab) => void;
  onCreateTab: () => void;
  createReason: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Keep the floating menu tied to the current interaction.
  useEffect(() => {
    if (!state) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const t = setTimeout(() => {
      window.addEventListener("mousedown", onDown);
      window.addEventListener("keydown", onKey);
      window.addEventListener("scroll", onClose, true);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [state, onClose]);

  if (!state) return null;

  const items = [
    { label: "Focus tab", action: () => onFocus(state.tab) },
    { label: "Rename tab...", action: () => onRename(state.tab) },
    { label: "Create tab", action: onCreateTab, reason: createReason },
    {
      label: "Close tab",
      danger: true,
      action: () => onCloseTab(state.tab),
    },
  ];
  const menuMargin = 8;
  const menuWidth = 200;
  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.max(
      menuMargin,
      Math.min(state.x, window.innerWidth - menuWidth - menuMargin),
    ),
    top: Math.max(
      menuMargin,
      Math.min(state.y, window.innerHeight - items.length * 34 - menuMargin),
    ),
    zIndex: 1000,
  };

  return (
    <div ref={ref} className="context-menu" style={style}>
      {items.map((item) => (
        <button
          key={item.label}
          disabled={!!item.reason}
          title={item.reason ?? undefined}
          className={`context-menu-item ${item.danger ? "is-danger" : ""}`}
          onClick={() => {
            onClose();
            item.action();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
