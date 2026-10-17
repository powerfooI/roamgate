import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  GripHorizontal,
  Move,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { browserPaneInDirection } from "../browserNavigation";
import { nearestPaneSide } from "../paneDrop";
import type { PaneLayout } from "../types";
import { type PaneSide, store, useStoreSelector } from "../store";
import "./PaneMoveMenu.css";

type Direction = "left" | "right" | "up" | "down";

const DIRECTIONS: {
  direction: Direction;
  label: string;
  Icon: typeof ArrowUp;
}[] = [
  { direction: "up", label: "Move pane up", Icon: ArrowUp },
  { direction: "left", label: "Move pane left", Icon: ArrowLeft },
  { direction: "right", label: "Move pane right", Icon: ArrowRight },
  { direction: "down", label: "Move pane down", Icon: ArrowDown },
];

/** How long a dragged pane hovers over a tab before that tab opens. */
const TAB_OPEN_DELAY_MS = 600;

const SIDE_LABELS: Record<PaneSide, string> = {
  left: "on the left",
  right: "on the right",
  up: "above",
  down: "below",
};

type DropTarget =
  | { kind: "swap"; element: HTMLElement; paneId: string }
  | { kind: "place"; element: HTMLElement; paneId: string; side: PaneSide }
  | { kind: "tab"; element: HTMLElement; tabId: string }
  | { kind: "new-tab"; element: HTMLElement };

function sameTarget(a: DropTarget | null, b: DropTarget | null) {
  if (!a || !b) return a === b;
  return (
    a.kind === b.kind &&
    a.element === b.element &&
    (a.kind !== "place" || b.kind !== "place" || a.side === b.side)
  );
}

function paneCell(paneId: string) {
  for (const cell of document.querySelectorAll<HTMLElement>(
    ".pane-layout > .pane-layout-cell",
  ))
    if (cell.dataset.paneId === paneId) return cell;
  return null;
}

/**
 * A hover-revealed handle for rearranging panes, with keyboard moves. Dropping
 * on a pane in the same tab swaps them; dropping on a tab moves the pane there,
 * and hovering a tab opens it so the pane can be placed beside one of its panes.
 */
export function PaneDragHandle({
  paneId,
  layout,
  onPointerDown,
}: {
  paneId: string;
  layout: PaneLayout | null;
  onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void;
}) {
  const drag = useRef<{ cancel: () => void; leftTab: boolean } | null>(null);
  // Opening another tab unmounts this handle, so only an in-tab drag ends here.
  useEffect(
    () => () => {
      if (!drag.current?.leftTab) drag.current?.cancel();
    },
    [],
  );
  const otherTabs = useStoreSelector(
    (state) =>
      state.tabs.filter(
        (tab) =>
          tab.workspace_id === layout?.workspace_id &&
          tab.tab_id !== layout?.tab_id,
      ).length,
  );

  const startDrag = (e: React.PointerEvent<HTMLButtonElement>) => {
    onPointerDown(e);
    if (!e.isPrimary || e.button !== 0 || drag.current) return;
    const button = e.currentTarget;
    if (!layout || layout.zoomed) return;
    const initial = store.get();
    const sourceTabId = layout.tab_id;
    const { pointerId, clientX: startX, clientY: startY } = e;
    let dragging = false;
    let target: DropTarget | null = null;
    let sourceCell: HTMLElement | null = null;
    let preview: HTMLDivElement | null = null;
    let hint: HTMLSpanElement | null = null;
    let openTabTimer: ReturnType<typeof setTimeout> | null = null;
    let openTabId: string | undefined;
    const session = { cancel: () => cleanup(), leftTab: false };
    const currentSession = () => {
      const current = store.get();
      if (
        current.activeConnectionId !== initial.activeConnectionId ||
        current.connectionGeneration !== initial.connectionGeneration ||
        current.serverRuntimeGeneration !== initial.serverRuntimeGeneration
      )
        return false;
      // The source tab may be in the background after another tab opened.
      return current.layout?.tab_id === sourceTabId
        ? !current.layout.zoomed &&
            current.layout.panes.some((pane) => pane.pane_id === paneId)
        : session.leftTab &&
            current.panes.some(
              (pane) => pane.pane_id === paneId && pane.tab_id === sourceTabId,
            );
    };
    const sourceTabPaneCount = () => {
      const current = store.get();
      return current.layout?.tab_id === sourceTabId
        ? current.layout.panes.length
        : current.panes.filter((pane) => pane.tab_id === sourceTabId).length;
    };
    const findTarget = (event: PointerEvent): DropTarget | null => {
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const current = store.get().layout;
      let cell = hit?.closest<HTMLElement>(".pane-layout-cell");
      let cellPaneId = cell?.dataset.paneId;
      if (!cell?.parentElement?.classList.contains("pane-layout")) {
        // A tab's only pane renders without the grid.
        cell = hit?.closest<HTMLElement>(
          ".workspace-terminal-surface > .terminal-shell",
        );
        cellPaneId =
          current?.panes.length === 1 ? current.panes[0].pane_id : undefined;
      }
      if (
        cell &&
        cellPaneId &&
        cellPaneId !== paneId &&
        current?.panes.some((pane) => pane.pane_id === cellPaneId)
      ) {
        if (current.tab_id === sourceTabId)
          return { kind: "swap", element: cell, paneId: cellPaneId };
        return {
          kind: "place",
          element: cell,
          paneId: cellPaneId,
          side: nearestPaneSide(
            cell.getBoundingClientRect(),
            event.clientX,
            event.clientY,
          ),
        };
      }
      const tab = hit?.closest<HTMLElement>(".tabbar-tab[data-tab-id]");
      if (tab) {
        // Hovering the source tab still opens it, but dropping there is a no-op.
        return tab.dataset.tabId === sourceTabId
          ? null
          : { kind: "tab", element: tab, tabId: tab.dataset.tabId! };
      }
      const strip = hit?.closest<HTMLElement>(".tabbar-tabs");
      const add = strip?.querySelector<HTMLElement>(".tabbar-add");
      return add && sourceTabPaneCount() > 1
        ? { kind: "new-tab", element: add }
        : null;
    };
    const hoveredTabId = (event: PointerEvent) =>
      document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>(".tabbar-tab[data-tab-id]")?.dataset.tabId;
    const clearOpenTabTimer = () => {
      if (openTabTimer) clearTimeout(openTabTimer);
      openTabTimer = null;
      openTabId = undefined;
    };
    const setTarget = (next: DropTarget | null) => {
      if (sameTarget(next, target)) return;
      if (target) {
        target.element.classList.remove(
          "is-swap-target",
          "is-place-target",
          "is-pane-drop-target",
        );
        delete target.element.dataset.dropSide;
      }
      target = next;
      if (!target) return;
      if (target.kind === "swap")
        target.element.classList.add("is-swap-target");
      else if (target.kind === "place") {
        target.element.classList.add("is-place-target");
        target.element.dataset.dropSide = target.side;
      } else target.element.classList.add("is-pane-drop-target");
    };
    const hintText = () => {
      switch (target?.kind) {
        case "swap":
          return "Release to swap";
        case "place":
          return `Release to place ${SIDE_LABELS[target.side]}`;
        case "tab": {
          const name =
            target.element.querySelector(".tabbar-name")?.textContent ||
            "this tab";
          return `Release to move to ${name}, or hold to open it`;
        }
        case "new-tab":
          return "Release to move to a new tab";
        default:
          return "Drag onto a pane or tab";
      }
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", drop, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("blur", cleanup);
      window.removeEventListener("keydown", escape, true);
      button.removeEventListener("lostpointercapture", lostCapture);
      clearOpenTabTimer();
      setTarget(null);
      preview?.remove();
      sourceCell?.classList.remove("is-swap-source");
      document.documentElement.classList.remove("is-pane-dragging");
      if (drag.current === session) drag.current = null;
      if (button.hasPointerCapture(pointerId))
        button.releasePointerCapture(pointerId);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      if (!(event.buttons & 1) || !currentSession()) return cleanup();
      if (!dragging) {
        if (Math.hypot(event.clientX - startX, event.clientY - startY) < 4)
          return;
        dragging = true;
        document.documentElement.classList.add("is-pane-dragging");
        preview = document.createElement("div");
        preview.className = "pane-move-preview";
        preview.setAttribute("aria-hidden", "true");
        const icon = button.lastElementChild?.cloneNode(true);
        if (icon) preview.append(icon);
        const label = document.createElement("strong");
        label.textContent = `Pane ${layout.panes.findIndex((pane) => pane.pane_id === paneId) + 1}`;
        hint = document.createElement("span");
        preview.append(label, hint);
        document.body.append(preview);
      }
      event.preventDefault();
      // The source cell is re-created when its tab is opened again.
      const nextSourceCell = paneCell(paneId);
      if (nextSourceCell !== sourceCell) {
        sourceCell?.classList.remove("is-swap-source");
        sourceCell = nextSourceCell;
        sourceCell?.classList.add("is-swap-source");
      }
      setTarget(findTarget(event));
      const tabId = hoveredTabId(event);
      if (tabId !== openTabId) clearOpenTabTimer();
      if (tabId && tabId !== store.get().layout?.tab_id && !openTabTimer) {
        openTabId = tabId;
        openTabTimer = setTimeout(() => {
          openTabTimer = null;
          openTabId = undefined;
          if (!currentSession()) return cleanup();
          session.leftTab ||= tabId !== sourceTabId;
          void store.focusTab(tabId);
        }, TAB_OPEN_DELAY_MS);
      }
      if (preview && hint) {
        preview.classList.toggle("is-ready", !!target);
        hint.textContent = hintText();
        // Pointer/rects use viewport pixels; the body inherits the app's CSS zoom.
        const rect = preview.getBoundingClientRect();
        const scale = rect.width / preview.offsetWidth || 1;
        const x = Math.max(
          8,
          Math.min(event.clientX + 16, window.innerWidth - rect.width - 8),
        );
        const y = Math.max(
          8,
          Math.min(event.clientY + 16, window.innerHeight - rect.height - 8),
        );
        preview.style.transform = `translate3d(${x / scale}px, ${y / scale}px, 0)`;
      }
    };
    const drop = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      const dropped = dragging && currentSession() ? findTarget(event) : null;
      cleanup();
      if (!dropped) return;
      if (dropped.kind === "swap") void store.swapPanes(paneId, dropped.paneId);
      else if (dropped.kind === "place")
        void store.movePaneBeside(paneId, dropped.paneId, dropped.side);
      else if (dropped.kind === "new-tab") void store.movePaneToNewTab(paneId);
      else {
        const panes = store
          .get()
          .panes.filter((pane) => pane.tab_id === dropped.tabId);
        const anchor = panes.find((pane) => pane.focused) ?? panes[0];
        if (anchor) void store.movePaneBeside(paneId, anchor.pane_id, "right");
      }
    };
    const cancel = (event: PointerEvent) => {
      if (event.pointerId === pointerId) cleanup();
    };
    const lostCapture = () => {
      // Capture also ends when the handle unmounts because another tab opened.
      if (button.isConnected) cleanup();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cleanup();
    };
    button.setPointerCapture(pointerId);
    drag.current = session;
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", drop, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("blur", cleanup);
    window.addEventListener("keydown", escape, true);
    button.addEventListener("lostpointercapture", lostCapture);
  };

  if (!layout || layout.zoomed || (layout.panes.length < 2 && !otherTabs))
    return null;

  return (
    <button
      type="button"
      className="pane-drag-handle"
      title="Drag to swap panes or onto a tab to move (arrow keys to move)"
      aria-label="Drag pane"
      aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
      onPointerDown={startDrag}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
          return;
        const direction = DIRECTIONS.find(
          ({ direction }) => event.key.toLowerCase() === `arrow${direction}`,
        )?.direction;
        if (!direction) return;
        event.preventDefault();
        event.stopPropagation();
        void store.movePane(paneId, direction);
      }}
    >
      <GripHorizontal size={12} />
    </button>
  );
}

/** Click for repeated directional moves; Escape dismisses the pad. */
export function PaneMoveMenu({
  paneId,
  layout,
  onPointerDown,
}: {
  paneId: string;
  layout: PaneLayout | null;
  onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const targets = Object.fromEntries(
    DIRECTIONS.map(({ direction }) => [
      direction,
      browserPaneInDirection(layout, paneId, direction),
    ]),
  ) as Record<Direction, string | null>;
  const canMove = Object.values(targets).some(Boolean);

  useEffect(() => {
    if (!canMove) setOpen(false);
  }, [canMove]);

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const dismissOnEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("keydown", dismissOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("keydown", dismissOnEscape, true);
    };
  }, [open]);

  if (!canMove) return null;

  return (
    <span className="pane-move-menu" ref={rootRef}>
      <button
        type="button"
        className={`terminal-pane-action${open ? " is-active" : ""}`}
        title="Move pane"
        aria-label="Move pane"
        aria-haspopup="true"
        aria-expanded={open}
        onPointerDown={onPointerDown}
        onClick={() => setOpen((value) => !value)}
      >
        <Move size={14} />
      </button>
      {open ? (
        <div className="pane-move-pad" role="group" aria-label="Move pane">
          {DIRECTIONS.map(({ direction, label, Icon }) => (
            <button
              type="button"
              key={direction}
              className={`terminal-pane-action pane-move-${direction}`}
              title={label}
              aria-label={label}
              disabled={!targets[direction]}
              onPointerDown={onPointerDown}
              onClick={() => store.movePane(paneId, direction)}
            >
              <Icon size={14} />
            </button>
          ))}
          <span className="pane-move-origin" aria-hidden="true" />
        </div>
      ) : null}
    </span>
  );
}
