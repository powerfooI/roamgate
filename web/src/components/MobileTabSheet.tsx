import { Pin, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  shallowEqual,
  store,
  useStoreSelector,
  useEndpointCreationReason,
} from "../store";
import { AgentStatusIcon } from "./AgentStatusIcon";
import { summarizeTabAgents } from "./agentSession";
import { CloseButton } from "./CloseButton";
import { focusIfUnchanged } from "./dialogFocus";
import { requestCloseTab, tabName } from "./TabBar";
import { orderTabsForDisplay, setTabPinned, useTabPins } from "../tabPins";
import { activePaneIdForSnapshot } from "../paneJump";
import { shortId } from "../utils";
import "./MobileTabSheet.css";

/**
 * Non-modal tab popup beside More, inside the app stacking context so the
 * persistent navigation rail remains usable. Provides tab switching and actions
 * in mobile layouts, where the tab strip is hidden.
 */
export function MobileTabSheet({
  open,
  onClose,
  onShowSession,
}: {
  open: boolean;
  onClose: () => void;
  onShowSession: () => void;
}) {
  const s = useStoreSelector(
    (state) => ({
      activeConnectionId: state.activeConnectionId,
      connectionGeneration: state.connectionGeneration,
      layout: state.layout,
      selectedPaneId: state.selectedPaneId,
      panes: state.panes,
      tabs: state.tabs,
      workspaces: state.workspaces,
    }),
    shallowEqual,
  );
  const sheetRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const transitionPendingRef = useRef(false);
  const [transitionPending, setTransitionPending] = useState(false);
  // A completion belongs to this opening and connection, not a later popup
  // (or More) reached while the request was in flight.
  const scope = JSON.stringify([
    s.activeConnectionId,
    s.connectionGeneration,
    s.workspaces.find((w) => w.focused)?.workspace_id,
  ]);
  const openingRef = useRef({ open, scope });
  if (openingRef.current.open !== open || openingRef.current.scope !== scope)
    openingRef.current = { open, scope };

  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const closeIfIdle = () => {
    if (!transitionPendingRef.current) onClose();
  };
  onCloseRef.current = closeIfIdle;

  const runTabTransition = async (operation: () => Promise<unknown>) => {
    if (transitionPendingRef.current) return;
    transitionPendingRef.current = true;
    setTransitionPending(true);
    const opening = openingRef.current;
    try {
      await operation();
      if (
        !mountedRef.current ||
        opening !== openingRef.current ||
        !openingRef.current.open
      )
        return;
      onClose();
      onShowSession();
    } finally {
      transitionPendingRef.current = false;
      setTransitionPending(false);
    }
  };

  const pinnedTabIds = useTabPins(s.activeConnectionId);
  const activePaneId = activePaneIdForSnapshot(s);
  const focusedWs = s.workspaces.find((w) => w.focused);
  const createReason = useEndpointCreationReason(
    "tab.create",
    focusedWs?.workspace_id,
  );
  const tabs = focusedWs
    ? orderTabsForDisplay(
        s.tabs.filter((t) => t.workspace_id === focusedWs.workspace_id),
        pinnedTabIds,
      )
    : [];

  useEffect(() => {
    if (!open) return;
    const sheet = sheetRef.current;
    // Focus once, without retries that could steal subsequent keyboard or
    // navigation focus. Never focus an editor (or reopen the phone keyboard).
    sheet
      ?.querySelector<HTMLButtonElement>("button")
      ?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Let stacked dialogs (e.g. the close-tab confirmation) handle Escape.
      if (document.querySelector(".modal-backdrop")) return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      const source = document.activeElement;
      if (source === document.body || (source && sheet?.contains(source)))
        focusIfUnchanged(document.querySelector(".mobile-appbar-tabs"), source);
    };
  }, [open]);

  if (!open) return null;

  return (
    <>
      <button
        type="button"
        className="mobile-more-backdrop mobile-tab-sheet-backdrop"
        aria-label="Close tab switcher"
        onClick={closeIfIdle}
      />
      <div
        ref={sheetRef}
        className="mobile-tab-sheet"
        id="mobile-tab-options"
        role="dialog"
        aria-label="Tabs"
        aria-busy={transitionPending}
        tabIndex={-1}
      >
        <div className="mobile-tab-sheet-head mobile-popup-head">
          <span>Tabs</span>
          <CloseButton
            label="Close tab switcher"
            disabled={transitionPending}
            onClick={closeIfIdle}
          />
        </div>
        {!focusedWs ? <p>Select or create a workspace to open tabs.</p> : null}
        <div className="mobile-tab-sheet-list" role="list">
          {tabs.map((t) => {
            const name = tabName(t);
            const panes = s.panes.filter((pane) => pane.tab_id === t.tab_id);
            const agentSummary = summarizeTabAgents(s.panes, t.tab_id);
            return (
              <div key={t.tab_id} role="listitem">
                <div
                  className={`mobile-tab-sheet-row ${t.focused ? "is-active" : ""}`}
                >
                  <button
                    type="button"
                    className="mobile-tab-sheet-focus"
                    disabled={transitionPending}
                    onClick={() =>
                      void runTabTransition(() => store.focusTab(t.tab_id))
                    }
                  >
                    {agentSummary ? (
                      <span
                        className="tabbar-agent-marker"
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
                    <span className="mobile-tab-sheet-name">{name}</span>
                  </button>
                  {pinnedTabIds.has(t.tab_id) ? (
                    <button
                      type="button"
                      className="mobile-tab-sheet-close"
                      aria-label={`Unpin ${name}`}
                      title="Unpin tab"
                      disabled={transitionPending}
                      onClick={() =>
                        setTabPinned(s.activeConnectionId, t.tab_id, false)
                      }
                    >
                      <Pin size={13} fill="currentColor" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="mobile-tab-sheet-close"
                      aria-label={`Close ${name}`}
                      title={`Close ${name}`}
                      disabled={transitionPending}
                      onClick={() => requestCloseTab(t.tab_id)}
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
                {panes.length > 1 ? (
                  <div
                    className="mobile-tab-sheet-panes"
                    role="list"
                    aria-label={`${name} panes`}
                  >
                    {panes.map((pane) => (
                      <div key={pane.pane_id} role="listitem">
                        <button
                          type="button"
                          className="mobile-tab-sheet-focus mobile-tab-sheet-pane"
                          aria-label={`${name}: Pane ${shortId(pane.pane_id)}`}
                          aria-description={
                            pane.agent || pane.foreground_cwd || pane.cwd
                          }
                          aria-current={
                            t.focused && pane.pane_id === activePaneId
                              ? "true"
                              : undefined
                          }
                          disabled={transitionPending}
                          onClick={() =>
                            void runTabTransition(() =>
                              store.focusPane(pane.pane_id),
                            )
                          }
                        >
                          <AgentStatusIcon
                            agent={pane.agent}
                            status={pane.agent_status}
                          />
                          <span className="mobile-tab-sheet-pane-label">
                            <span>Pane {shortId(pane.pane_id)}</span>
                            <span className="mobile-tab-sheet-pane-detail">
                              {pane.agent ||
                                pane.foreground_cwd ||
                                pane.cwd ||
                                "Terminal"}
                            </span>
                          </span>
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className="mobile-tab-sheet-new"
          title={createReason ?? undefined}
          disabled={!focusedWs || transitionPending || !!createReason}
          onClick={() =>
            void runTabTransition(() =>
              store.createTab(focusedWs!.workspace_id),
            )
          }
        >
          <Plus size={15} />
          <span>{createReason ?? "New Tab"}</span>
        </button>
      </div>
    </>
  );
}
