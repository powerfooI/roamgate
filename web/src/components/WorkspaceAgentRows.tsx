import { useEffect, useLayoutEffect, useRef } from "react";
import {
  focusTreeItem,
  keyboardContextMenuPoint,
  treeKeyboardAction,
} from "./treeKeyboard";
import { store, useStoreSelector } from "../store";
import type { Pane } from "../types";
import { agentClass, basename, shortId } from "../utils";
import { shouldShowAgentStatusLabel } from "./agentSession";
import { AgentStatusIcon } from "./AgentStatusIcon";
import { observeClampedContextMenu } from "./contextMenuPosition";
import { TREE_DEPTH_INDENT } from "./treeIndent";
import "./WorkspaceAgentRows.css";

const LONG_PRESS_MS = 550;
const LONG_PRESS_MOVE_PX = 10;

export interface AgentMenuState {
  pane: Pane;
  x: number;
  y: number;
}

type AgentContextMenuItem = {
  label: string;
  danger?: boolean;
  action: () => void;
};

type AgentContextMenuGroup = {
  label: string;
  items: AgentContextMenuItem[];
  danger?: boolean;
};

function agentLocationName(pane: Pane): string {
  const location = pane.foreground_cwd ?? pane.cwd;
  return location ? basename(location.replace(/\\/g, "/")) : "";
}

export function AgentRow({
  pane,
  selected,
  depth = 0,
  showPaneId,
  variant = "nested",
  workspaceLabel,
  onSelect,
  onOpenMenu,
  drag,
}: {
  pane: Pane;
  selected: boolean;
  depth?: number;
  showPaneId: boolean;
  variant?: "nested" | "standalone";
  workspaceLabel?: string;
  onSelect?: (pane: Pane) => void;
  onOpenMenu: (x: number, y: number) => void;
  drag?: {
    isDragging: boolean;
    dropPosition: "before" | "after" | null;
    onDragStart: (event: React.DragEvent<HTMLDivElement>) => void;
    onDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
    onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
    onDragEnd: () => void;
  };
}) {
  const tabLabel = useStoreSelector((state) => {
    const label = state.tabs
      .find(
        (tab) =>
          tab.tab_id === pane.tab_id && tab.workspace_id === pane.workspace_id,
      )
      ?.label.trim();
    return label && !/^(?:Tab )?\d+$/.test(label) ? label : "";
  });
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStart = useRef<{ x: number; y: number } | null>(null);
  const longPressTriggered = useRef(false);

  const clearLongPressTimer = () => {
    if (!longPressTimer.current) return;
    clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };

  useEffect(() => clearLongPressTimer, []);

  const openMenu = (x: number, y: number) => {
    onOpenMenu(x, y);
  };
  const showStatus = shouldShowAgentStatusLabel(pane.agent_status);
  const nested = variant === "nested";
  const locationName = agentLocationName(pane);

  return (
    <div
      className={`agent-row ${nested ? "is-nested" : "is-standalone"} ${
        selected ? "is-selected" : ""
      } ${pane.focused ? "is-focused" : ""} ${
        drag?.isDragging ? "is-dragging" : ""
      } ${drag?.dropPosition ? `drop-${drag.dropPosition}` : ""}`}
      style={
        nested
          ? { marginLeft: TREE_DEPTH_INDENT + depth * TREE_DEPTH_INDENT }
          : undefined
      }
      role={nested ? "treeitem" : "button"}
      draggable={!!drag}
      onDragStart={drag?.onDragStart}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      onDragEnd={drag?.onDragEnd}
      tabIndex={nested ? (selected ? 0 : -1) : 0}
      aria-level={nested ? depth + 1 : undefined}
      aria-selected={nested ? selected : undefined}
      aria-pressed={nested ? undefined : selected}
      onClick={(e) => {
        if (longPressTriggered.current) {
          longPressTriggered.current = false;
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        void store.focusPane(pane.pane_id);
        onSelect?.(pane);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        const action = treeKeyboardAction(event.key, event.shiftKey);
        if (!action) return;
        if (
          nested &&
          (action === "next" ||
            action === "previous" ||
            action === "first" ||
            action === "last")
        ) {
          event.preventDefault();
          focusTreeItem(event.currentTarget, action);
          return;
        }
        if (nested && (action === "expand" || action === "collapse")) {
          event.preventDefault();
          focusTreeItem(
            event.currentTarget,
            action === "expand" ? "next" : "previous",
          );
          return;
        }
        if (action !== "activate" && action !== "context-menu") return;
        event.preventDefault();
        event.stopPropagation();
        if (action === "activate") {
          void store.focusPane(pane.pane_id);
          onSelect?.(pane);
        } else {
          const point = keyboardContextMenuPoint(event.currentTarget);
          openMenu(point.x, point.y);
        }
      }}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse") return;
        longPressTriggered.current = false;
        longPressStart.current = { x: e.clientX, y: e.clientY };
        clearLongPressTimer();
        longPressTimer.current = setTimeout(() => {
          longPressTriggered.current = true;
          openMenu(e.clientX, e.clientY);
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
      onPointerUp={() => {
        clearLongPressTimer();
        longPressStart.current = null;
      }}
      onPointerCancel={() => {
        clearLongPressTimer();
        longPressStart.current = null;
      }}
      onPointerLeave={() => {
        clearLongPressTimer();
        longPressStart.current = null;
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY);
      }}
      title={[pane.pane_id, tabLabel, pane.cwd].filter(Boolean).join(" · ")}
      aria-label={`${pane.agent ?? "Agent"} pane${tabLabel ? `, tab ${tabLabel}` : ""}, status ${pane.agent_status}`}
    >
      <AgentStatusIcon agent={pane.agent} status={pane.agent_status} />
      <div className="agent-info">
        <div className="agent-title">
          <span className="agent-title-label">
            {nested
              ? (pane.agent ?? "Agent")
              : (workspaceLabel ?? pane.workspace_id)}
            {tabLabel ? <span className="muted"> · {tabLabel}</span> : null}
            {showPaneId ? (
              <span className="muted"> · {shortId(pane.pane_id)}</span>
            ) : null}
            {nested && locationName ? (
              <span className="muted"> · {locationName}</span>
            ) : null}
          </span>
          {showStatus ? (
            <span
              className={`${agentClass(pane.agent_status)} agent-row-status`}
            >
              {pane.agent_status}
            </span>
          ) : null}
        </div>
        {!nested ? (
          <div className="agent-sub muted">
            {pane.agent ?? "Agent"}
            {pane.cwd ? ` · ${basename(pane.cwd)}` : ""}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function AgentContextMenu({
  state,
  onClose,
  onFocus,
  onBrowseFiles,
  onReviewChanges,
  onViewHistory,
  onExportSession,
  onClosePane,
}: {
  state: AgentMenuState | null;
  onClose: () => void;
  onFocus: (pane: Pane) => void;
  onBrowseFiles?: (pane: Pane) => void;
  onReviewChanges?: (pane: Pane) => void;
  onViewHistory?: (pane: Pane) => void;
  onExportSession: (pane: Pane) => void;
  onClosePane: (pane: Pane) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!state) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = (e: Event) => {
      const target = e.target;
      if (target instanceof Node && ref.current?.contains(target)) return;
      onClose();
    };
    const t = setTimeout(() => {
      window.addEventListener("mousedown", onDown);
      window.addEventListener("keydown", onKey);
      window.addEventListener("scroll", onScroll, true);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [state, onClose]);

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!state || !menu) return;
    return observeClampedContextMenu(menu, {
      left: state.x,
      top: state.y,
    });
  }, [state]);

  if (!state) return null;

  const groups: AgentContextMenuGroup[] = [
    {
      label: "Open",
      items: [
        { label: "Open terminal", action: () => onFocus(state.pane) },
        {
          label: "Browse files at agent CWD",
          action: () => onBrowseFiles?.(state.pane),
        },
        {
          label: "Review workspace changes",
          action: () => onReviewChanges?.(state.pane),
        },
      ],
    },
    {
      label: "Session",
      items: [
        {
          label: "View agent history",
          action: () => onViewHistory?.(state.pane),
        },
        {
          label: "Export session",
          action: () => onExportSession(state.pane),
        },
      ],
    },
    {
      label: "Pane",
      danger: true,
      items: [
        {
          label: "Close pane",
          danger: true,
          action: () => onClosePane(state.pane),
        },
      ],
    },
  ];
  const style: React.CSSProperties = {
    position: "fixed",
    left: state.x,
    top: state.y,
    zIndex: 1000,
  };
  const agentName = state.pane.agent ?? "Agent";
  const locationName = agentLocationName(state.pane);

  return (
    <div ref={ref} className="context-menu context-menu--grouped" style={style}>
      <div className="context-menu-header">
        <span>Agent</span>
        <strong title={agentName}>{agentName}</strong>
        <small>
          {state.pane.agent_status}
          {locationName ? ` · ${locationName}` : ""}
        </small>
      </div>
      {groups.map((group) => (
        <div
          key={group.label}
          className={`context-menu-group ${group.danger ? "is-danger" : ""}`}
        >
          <div className="context-menu-group-title">{group.label}</div>
          {group.items.map((item) => (
            <button
              key={item.label}
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
      ))}
    </div>
  );
}
