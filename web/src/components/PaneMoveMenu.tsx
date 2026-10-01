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
import type { PaneLayout } from "../types";
import { store } from "../store";
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

/** A hover-revealed handle for swapping visible panes, with keyboard moves. */
export function PaneDragHandle({
  paneId,
  layout,
  onPointerDown,
}: {
  paneId: string;
  layout: PaneLayout | null;
  onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void;
}) {
  const cancelDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelDrag.current?.(), []);

  const startDrag = (e: React.PointerEvent<HTMLButtonElement>) => {
    onPointerDown(e);
    if (!e.isPrimary || e.button !== 0 || cancelDrag.current) return;
    const button = e.currentTarget;
    const source = button.closest<HTMLElement>(".pane-layout-cell");
    const grid = source?.closest<HTMLElement>(".pane-layout");
    if (!source || !grid || !layout || layout.zoomed) return;
    const initial = store.get();
    const { pointerId, clientX: startX, clientY: startY } = e;
    let dragging = false;
    let target: HTMLElement | null = null;
    let preview: HTMLDivElement | null = null;
    let hint: HTMLSpanElement | null = null;
    const currentSession = () => {
      const current = store.get();
      return (
        current.activeConnectionId === initial.activeConnectionId &&
        current.connectionGeneration === initial.connectionGeneration &&
        current.serverRuntimeGeneration === initial.serverRuntimeGeneration &&
        current.layout?.tab_id === layout.tab_id &&
        !current.layout.zoomed &&
        current.layout.panes.some((pane) => pane.pane_id === paneId)
      );
    };
    const findTarget = (event: PointerEvent) => {
      const cell = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>(".pane-layout-cell");
      return cell &&
        cell !== source &&
        cell.parentElement === grid &&
        store
          .get()
          .layout?.panes.some((pane) => pane.pane_id === cell.dataset.paneId)
        ? cell
        : null;
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", drop, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("blur", cleanup);
      window.removeEventListener("keydown", escape, true);
      button.removeEventListener("lostpointercapture", cleanup);
      target?.classList.remove("is-swap-target");
      preview?.remove();
      source.classList.remove("is-swap-source");
      grid.classList.remove("is-swapping");
      cancelDrag.current = null;
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
        source.classList.add("is-swap-source");
        grid.classList.add("is-swapping");
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
      const nextTarget = findTarget(event);
      if (nextTarget !== target) {
        target?.classList.remove("is-swap-target");
        target = nextTarget;
        target?.classList.add("is-swap-target");
      }
      if (preview && hint) {
        preview.classList.toggle("is-ready", !!target);
        hint.textContent = target
          ? "Release to swap"
          : "Drag onto another pane";
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
      const targetId =
        dragging && currentSession() ? findTarget(event)?.dataset.paneId : null;
      cleanup();
      if (targetId) void store.swapPanes(paneId, targetId);
    };
    const cancel = (event: PointerEvent) => {
      if (event.pointerId === pointerId) cleanup();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cleanup();
    };
    button.setPointerCapture(pointerId);
    cancelDrag.current = cleanup;
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", drop, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("blur", cleanup);
    window.addEventListener("keydown", escape, true);
    button.addEventListener("lostpointercapture", cleanup);
  };

  if (!layout || layout.zoomed || layout.panes.length < 2) return null;

  return (
    <button
      type="button"
      className="pane-drag-handle"
      title="Drag to swap panes (arrow keys to move)"
      aria-label="Drag pane to swap"
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
