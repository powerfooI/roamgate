import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Move } from "lucide-react";
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

/**
 * One toolbar button that unfolds a directional pad for swapping the pane
 * with a neighbor. It stays open for repeated moves and dismisses on Escape or
 * any press outside the pad.
 */
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
