export const OVERLAY_SCROLLBAR_EXCLUDED_SELECTOR = [
  ".modal-backdrop",
  ".popover-content",
  ".config-dropdown",
  ".context-menu",
  ".pane-jump-popover",
  ".agent-session-export-menu",
  ".conversation-minimap-track",
  ".terminal-mobile-keys-panel",
  ".terminal-composer-shortcuts",
  "[role=dialog]",
  "[role=menu]",
  "[role=listbox]",
].join(", ");

export function overlayScrollbarExcludedElement(
  element: Pick<Element, "closest">,
): boolean {
  return Boolean(element.closest(OVERLAY_SCROLLBAR_EXCLUDED_SELECTOR));
}

export type OverlayThumbGeometry = {
  start: number;
  size: number;
  trackLength: number;
  maxScroll: number;
};

export function calculateOverlayThumb({
  viewportStart,
  viewportSize,
  clientSize,
  scrollSize,
  scrollOffset,
  inset = 3,
  minSize = 28,
}: {
  viewportStart: number;
  viewportSize: number;
  clientSize: number;
  scrollSize: number;
  scrollOffset: number;
  inset?: number;
  minSize?: number;
}): OverlayThumbGeometry | null {
  if (viewportSize <= 0 || clientSize <= 0 || scrollSize <= clientSize + 1) {
    return null;
  }

  const trackLength = Math.max(0, viewportSize - inset * 2);
  const proportionalSize = trackLength * (clientSize / scrollSize);
  const size = Math.min(trackLength, Math.max(minSize, proportionalSize));
  const maxScroll = Math.max(0, scrollSize - clientSize);
  const scrollRatio = Math.min(1, Math.max(0, scrollOffset / maxScroll));
  const travel = Math.max(0, trackLength - size);

  return {
    start: viewportStart + inset + travel * scrollRatio,
    size,
    trackLength,
    maxScroll,
  };
}
