import type { Terminal } from "@xterm/xterm";

export type TerminalScroll = {
  direction: "up" | "down";
  lines: number;
  source: "wheel" | "page-key" | "history";
};

export type TerminalWheelScroll = TerminalScroll & { source: "wheel" };

const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/** Normalizes browser wheel units into Herdr's terminal scroll request shape. */
export function terminalWheelScroll(
  deltaY: number,
  deltaMode: number,
  rows: number,
): TerminalWheelScroll | null {
  if (deltaY === 0) return null;

  const lines =
    deltaMode === DOM_DELTA_PAGE
      ? Math.max(1, rows)
      : deltaMode === DOM_DELTA_LINE
        ? Math.max(1, Math.ceil(Math.abs(deltaY)))
        : deltaMode === DOM_DELTA_PIXEL
          ? Math.max(1, Math.ceil(Math.abs(deltaY) / 40))
          : Math.max(1, Math.ceil(Math.abs(deltaY)));

  return {
    direction: deltaY < 0 ? "up" : "down",
    lines,
    source: "wheel",
  };
}

/** Full pages let Herdr route the key; half pages explicitly scroll history. */
export function terminalPageScroll(
  direction: "up" | "down",
  rows: number,
  amount: "full" | "half" = "full",
): TerminalScroll {
  const viewportLines = Math.max(1, rows - 2);
  return {
    direction,
    lines:
      amount === "half"
        ? Math.max(1, Math.floor(viewportLines / 2))
        : viewportLines,
    // The bridge retains legacy wheel semantics for half pages, but endpoint
    // sessions must distinguish these coordinate-less shortcuts from a mouse.
    source: amount === "full" ? "page-key" : "history",
  };
}

/**
 * The terminal cell under a client point. Herdr uses the cell to pick which
 * pane a wheel event belongs to, so a scroll request carries it alongside the
 * direction and line count. Returns an empty object when the geometry is not
 * measurable yet (no element, or a zero-sized view), which the callers spread
 * into the request as "no cell".
 */
export function terminalCellAtPoint(
  term: Terminal,
  clientX: number,
  clientY: number,
) {
  const element = term.element;
  if (!element || term.cols <= 0 || term.rows <= 0) return {};
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(style.paddingRight) || 0;
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
  const width = rect.width - paddingLeft - paddingRight;
  const height = rect.height - paddingTop - paddingBottom;
  if (width <= 0 || height <= 0) return {};

  const x = clientX - rect.left - paddingLeft;
  const y = clientY - rect.top - paddingTop;
  const column = Math.max(
    0,
    Math.min(term.cols - 1, Math.floor(x / (width / term.cols))),
  );
  const row = Math.max(
    0,
    Math.min(term.rows - 1, Math.floor(y / (height / term.rows))),
  );
  return { column, row };
}

export function terminalCellAt(term: Terminal, e: WheelEvent) {
  return terminalCellAtPoint(term, e.clientX, e.clientY);
}
