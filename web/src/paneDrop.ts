import type { PaneSide } from "./store";

/**
 * Picks the pane edge nearest a pointer, measured relative to the pane size so
 * the drop zones meet along the pane's diagonals.
 */
export function nearestPaneSide(
  rect: { left: number; top: number; width: number; height: number },
  x: number,
  y: number,
): PaneSide {
  const fx = (x - rect.left) / Math.max(1, rect.width);
  const fy = (y - rect.top) / Math.max(1, rect.height);
  const distances: [PaneSide, number][] = [
    ["left", fx],
    ["right", 1 - fx],
    ["up", fy],
    ["down", 1 - fy],
  ];
  return distances.reduce((best, next) => (next[1] < best[1] ? next : best))[0];
}
