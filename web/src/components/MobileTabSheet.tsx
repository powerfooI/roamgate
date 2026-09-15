import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  shallowEqual,
  store,
  useStoreSelector,
  useEndpointCreationReason,
} from "../store";
import { AgentStatusIcon } from "./AgentStatusIcon";
import { summarizeTabAgents } from "./agentSession";
import { CloseButton } from "./CloseButton";
import { focusDialogElement } from "./dialogFocus";
import { requestCloseTab, tabName } from "./TabBar";
import "./MobileTabSheet.css";

/**
 * Bottom-sheet tab switcher for narrow layouts. The tab strip hides itself on
 * mobile when a workspace has a single tab, so this sheet is the touch
 * affordance for creating, switching, and closing tabs there.
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

  const closeIfIdle = () => {
    if (!transitionPendingRef.current) onClose();
  };
  onCloseRef.current = closeIfIdle;

  const runTabTransition = async (operation: () => Promise<unknown>) => {
    if (transitionPendingRef.current) return;
    transitionPendingRef.current = true;
    setTransitionPending(true);
    try {
      await operation();
      onClose();
      onShowSession();
    } finally {
      transitionPendingRef.current = false;
      setTransitionPending(false);
    }
  };

  const focusedWs = s.workspaces.find((w) => w.focused);
  const createReason = useEndpointCreationReason(
    "tab.create",
    focusedWs?.workspace_id,
  );
  const tabs = focusedWs
    ? s.tabs
        .filter((t) => t.workspace_id === focusedWs.workspace_id)
        .sort((a, b) => a.number - b.number)
    : [];

  useEffect(() => {
    if (!open) return;
    const cancelFocus = focusDialogElement(sheetRef.current);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Let stacked dialogs (e.g. the close-tab confirmation) handle Escape.
      if (
        document.querySelector(
          ".modal-backdrop:not(.mobile-tab-sheet-backdrop)",
        )
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      cancelFocus();
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [open]);

  if (!open || !focusedWs) return null;

  return createPortal(
    <div
      className="modal-backdrop mobile-tab-sheet-backdrop"
      onMouseDown={closeIfIdle}
    >
      <div
        ref={sheetRef}
        className="mobile-tab-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Tabs"
        aria-busy={transitionPending}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="mobile-tab-sheet-head">
          <h3>Tabs</h3>
          <CloseButton
            label="Close tab switcher"
            disabled={transitionPending}
            onClick={closeIfIdle}
          />
        </div>
        <div className="mobile-tab-sheet-list" role="list">
          {tabs.map((t) => {
            const name = tabName(t);
            const agentSummary = summarizeTabAgents(s.panes, t.tab_id);
            return (
              <div
                key={t.tab_id}
                role="listitem"
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
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className="mobile-tab-sheet-new"
          title={createReason ?? undefined}
          disabled={transitionPending || !!createReason}
          onClick={() =>
            void runTabTransition(() => store.createTab(focusedWs.workspace_id))
          }
        >
          <Plus size={15} />
          <span>{createReason ?? "New Tab"}</span>
        </button>
      </div>
    </div>,
    document.body,
  );
}
