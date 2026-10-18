/** Matches `--tabbar-fade` in TabBar.css. */
export const TAB_STRIP_FADE_PX = 24;
/** Line-mode wheel deltas (Firefox on some mice) are reported in lines. */
const WHEEL_LINE_PX = 40;
/** Fractional scroll positions can stop just short of either edge. */
const EDGE_TOLERANCE_PX = 1;

export interface TabStripMetrics {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}

export interface TabStripWheel {
  deltaX: number;
  deltaY: number;
  /** `WheelEvent.deltaMode`: 0 pixels, 1 lines, 2 pages. */
  deltaMode: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

const maxScrollLeft = ({ scrollWidth, clientWidth }: TabStripMetrics) =>
  Math.max(0, scrollWidth - clientWidth);

const clampScrollLeft = (metrics: TabStripMetrics, left: number) =>
  Math.min(Math.max(0, left), maxScrollLeft(metrics));

/** Which edges of the tab strip hide tabs beyond them. */
export function tabStripOverflow(metrics: TabStripMetrics) {
  const max = maxScrollLeft(metrics);
  return {
    start: metrics.scrollLeft > EDGE_TOLERANCE_PX,
    end: max - metrics.scrollLeft > EDGE_TOLERANCE_PX,
  };
}

/**
 * Maps a vertical mouse wheel onto horizontal strip travel. Returns the new
 * scroll position, or null when the browser should handle the event itself:
 * horizontal and Shift+wheel gestures already scroll the strip natively,
 * Ctrl/Cmd+wheel zooms, and a strip at its edge has nowhere to go.
 */
export function tabStripWheelScrollLeft(
  metrics: TabStripMetrics,
  wheel: TabStripWheel,
) {
  if (wheel.shiftKey || wheel.ctrlKey || wheel.metaKey) return null;
  if (Math.abs(wheel.deltaX) >= Math.abs(wheel.deltaY)) return null;
  const unit =
    wheel.deltaMode === 1
      ? WHEEL_LINE_PX
      : wheel.deltaMode === 2
        ? metrics.clientWidth
        : 1;
  const next = clampScrollLeft(
    metrics,
    metrics.scrollLeft + wheel.deltaY * unit,
  );
  return next === metrics.scrollLeft ? null : next;
}

/**
 * Scroll position that brings a tab fully into view, clear of the edge fades.
 * `tab.left` is relative to the strip's scrolled content. Returns null when the
 * tab is already visible. A tab wider than the visible strip aligns its start.
 */
export function tabRevealScrollLeft(
  metrics: TabStripMetrics,
  tab: { left: number; width: number },
  margin = TAB_STRIP_FADE_PX,
) {
  const { scrollLeft, clientWidth } = metrics;
  const start = tab.left - margin;
  const end = tab.left + tab.width + margin;
  let next = scrollLeft;
  if (start < scrollLeft || end - start > clientWidth) next = start;
  else if (end > scrollLeft + clientWidth) next = end - clientWidth;
  next = clampScrollLeft(metrics, next);
  return Math.abs(next - scrollLeft) < EDGE_TOLERANCE_PX ? null : next;
}
