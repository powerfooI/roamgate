import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import {
  clampMobileControlsOffset,
  type MobileControlsPlacement,
  type MobileControlsStackBounds,
  mobileControlsSideForRelease,
} from "../mobileControlsPlacement";

/** The fixed elements that make up the floating mobile control stack. */
const STACK_SELECTOR =
  ".mobile-terminal-controls, .mobile-nav:not(.mobile-terminal-tools)";
/** Chrome along the top that the stack must not cover. */
const HEADER_SELECTOR = ".topbar, .main > .tabbar";
/** Controls pinned to the top right of the terminal, clear of a right-edge stack. */
const RIGHT_EDGE_SELECTOR = ".terminal-mobile-keys-toggle";
const COMPOSER_SELECTOR = ".terminal-composer, .terminal-composer-commands";
const GEOMETRY_SELECTOR = `${HEADER_SELECTOR}, ${RIGHT_EDGE_SELECTOR}, ${COMPOSER_SELECTOR}, .mobile-controls-stack`;
const COMPACT_ATTRIBUTE = "data-mobile-controls-compact";
const DRAG_THRESHOLD_PX = 8;
const EDGE_GAP_PX = 8;
const SETTLE_MS = 220;

function stackElements(app: HTMLElement) {
  return Array.from(app.querySelectorAll<HTMLElement>(STACK_SELECTOR)).filter(
    (element) =>
      getComputedStyle(element).display !== "none" &&
      element.getAttribute("aria-hidden") !== "true",
  );
}

let safeAreaProbe: HTMLDivElement | null = null;

/** CSS env() values are not readable from script; measure a fixed probe instead. */
function safeAreaBottom() {
  if (!safeAreaProbe) {
    safeAreaProbe = document.createElement("div");
    safeAreaProbe.setAttribute("aria-hidden", "true");
    safeAreaProbe.style.cssText =
      "position:fixed;left:0;bottom:0;width:0;height:env(safe-area-inset-bottom,0px);visibility:hidden;pointer-events:none";
    document.body.append(safeAreaProbe);
  }
  return safeAreaProbe.offsetHeight;
}

function visibleRect(element: HTMLElement) {
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return null;
  const rect = element.getBoundingClientRect();
  return rect.height > 0 ? rect : null;
}

function measureAvailableArea(
  app: HTMLElement,
  side: MobileControlsPlacement["side"],
  scale: number,
) {
  const viewport = window.visualViewport;
  const viewportTop = (viewport?.offsetTop ?? 0) / scale;
  const viewportBottom =
    Math.min(
      app.getBoundingClientRect().bottom,
      window.innerHeight,
      viewport ? viewport.offsetTop + viewport.height : window.innerHeight,
    ) / scale;
  let headerBottom = viewportTop;
  const selector =
    side === "right"
      ? `${HEADER_SELECTOR}, ${RIGHT_EDGE_SELECTOR}`
      : HEADER_SELECTOR;
  for (const header of app.querySelectorAll<HTMLElement>(selector)) {
    const rect = visibleRect(header);
    if (rect) headerBottom = Math.max(headerBottom, rect.bottom / scale);
  }
  let maxBottom = viewportBottom - EDGE_GAP_PX - safeAreaBottom();
  // In compact layout the picker scrolls inside the dock and is clipped to it.
  const composerSelector = app.hasAttribute(COMPACT_ATTRIBUTE)
    ? ".terminal-composer"
    : COMPOSER_SELECTOR;
  for (const composer of app.querySelectorAll<HTMLElement>(composerSelector)) {
    const rect = visibleRect(composer);
    if (rect) maxBottom = Math.min(maxBottom, rect.top / scale - EDGE_GAP_PX);
  }
  return {
    minTop: headerBottom + EDGE_GAP_PX,
    maxBottom,
    viewportBottom,
    viewportTop,
  };
}

/**
 * Normal-stack geometry in CSS pixels at `offsetY = 0`. Layout boxes come
 * from the resolved `bottom`, ignoring collapse/drag animation transforms.
 * Call with compact layout disabled, whose children instead use normal flow.
 */
function measureStackBounds(
  app: HTMLElement,
  appliedOffset: number,
  side: MobileControlsPlacement["side"],
): MobileControlsStackBounds | null {
  const elements = stackElements(app);
  if (elements.length === 0) return null;
  const appRect = app.getBoundingClientRect();
  const scale = appRect.width / app.offsetWidth;
  if (!Number.isFinite(scale) || scale <= 0) return null;
  let top = Infinity;
  let bottom = -Infinity;
  for (const element of elements) {
    const elementBottom =
      appRect.bottom / scale -
      Number.parseFloat(getComputedStyle(element).bottom);
    if (!Number.isFinite(elementBottom)) continue;
    top = Math.min(top, elementBottom - element.offsetHeight);
    bottom = Math.max(bottom, elementBottom);
  }
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return null;
  const area = measureAvailableArea(app, side, scale);
  return {
    top: top + appliedOffset,
    bottom: bottom + appliedOffset,
    minTop: area.minTop,
    maxBottom: area.maxBottom,
  };
}

function clearCompactLayout(app: HTMLElement) {
  app.removeAttribute(COMPACT_ATTRIBUTE);
  app.style.removeProperty("--mobile-controls-compact-bottom");
  app.style.removeProperty("--mobile-controls-composer-max-height");
}

function reducedMotion() {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Drag the mobile controls toggle to move the whole floating stack. Release
 * snaps to the nearer side edge and keeps the dragged height. Returns the
 * offset to apply, which is re-clamped when the viewport changes while the
 * stored placement stays untouched.
 */
export function useMobileControlsDrag({
  enabled,
  appRef,
  toggleRef,
  placement,
  onPlacementChange,
}: {
  enabled: boolean;
  appRef: RefObject<HTMLElement | null>;
  toggleRef: RefObject<HTMLElement | null>;
  placement: MobileControlsPlacement;
  onPlacementChange: (placement: MobileControlsPlacement) => void;
}): number {
  const [appliedOffset, setAppliedOffset] = useState(placement.offsetY);
  const latest = useRef({ placement, appliedOffset, onPlacementChange });
  useLayoutEffect(() => {
    latest.current = { placement, appliedOffset, onPlacementChange };
  });
  const dragging = useRef(false);
  // A user may drag farther up while the dock has already lifted the stack.
  // Keep that deliberate displacement during the obstruction without baking
  // the automatic lift into storage. Clear it once the resting height fits.
  const dragAnchor = useRef<{ offsetY: number; savedOffset: number } | null>(
    null,
  );

  // Clamp the stored height against the current layout. The stored value is
  // kept, so returning to a taller viewport restores it.
  const reclamp = useRef(() => {});
  reclamp.current = () => {
    const app = appRef.current;
    if (!enabled || !app || dragging.current) return;
    if (document.documentElement.dataset.layout !== "mobile") return;
    // Measure the unrestrained dock before deciding on compact layout. Using
    // its already-capped height would oscillate between compact and expanded.
    const row = app.querySelector<HTMLElement>(".mobile-controls-stack");
    const compactScroll = app.hasAttribute(COMPACT_ATTRIBUTE)
      ? {
          left: row?.scrollLeft ?? 0,
          composers: Array.from(
            app.querySelectorAll<HTMLElement>(".terminal-composer"),
            (element) => ({ element, top: element.scrollTop }),
          ),
        }
      : null;
    clearCompactLayout(app);
    const bounds = measureStackBounds(
      app,
      latest.current.appliedOffset,
      latest.current.placement.side,
    );
    if (!bounds) return;
    if (bounds.bottom - bounds.top > bounds.maxBottom - bounds.minTop) {
      app.setAttribute(COMPACT_ATTRIBUTE, "");
      const appRect = app.getBoundingClientRect();
      const scale = appRect.width / app.offsetWidth;
      const area = measureAvailableArea(
        app,
        latest.current.placement.side,
        scale,
      );
      // In tiny landscape viewports the dock scrolls. If even one row plus
      // usable editing space cannot fit below the header, prioritize the row
      // and editor over header clearance, bounded by the visual viewport.
      const rowHeight = row?.offsetHeight ?? 42;
      const reservedHeight = rowHeight + EDGE_GAP_PX * 2;
      const minimumComposerHeight = Math.min(
        64 + safeAreaBottom(),
        Math.max(0, area.viewportBottom - area.viewportTop - reservedHeight),
      );
      app.style.setProperty(
        "--mobile-controls-composer-max-height",
        `${Math.max(minimumComposerHeight, area.viewportBottom - area.minTop - reservedHeight)}px`,
      );
      if (compactScroll) {
        if (row) row.scrollLeft = compactScroll.left;
        for (const { element, top } of compactScroll.composers)
          element.scrollTop = top;
      }
      const compactArea = measureAvailableArea(
        app,
        latest.current.placement.side,
        scale,
      );
      app.style.setProperty(
        "--mobile-controls-compact-bottom",
        `${appRect.bottom / scale - compactArea.maxBottom}px`,
      );
    }
    let requestedOffset = latest.current.placement.offsetY;
    const anchor = dragAnchor.current;
    if (anchor) {
      const anchorOffset = clampMobileControlsOffset(anchor.offsetY, bounds);
      if (
        anchor.savedOffset !== requestedOffset ||
        anchorOffset === anchor.offsetY
      ) {
        dragAnchor.current = null;
      } else {
        requestedOffset += anchorOffset - anchor.offsetY;
      }
    }
    setAppliedOffset(clampMobileControlsOffset(requestedOffset, bounds));
  };
  // After every commit: headers and Composer may mount after the first paint.
  useLayoutEffect(() => reclamp.current());
  useEffect(() => {
    const app = appRef.current;
    if (!enabled || !app) return;
    const update = () => reclamp.current();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    const observed = new Set<HTMLElement>();
    const syncObserved = () => {
      const elements = new Set([
        app,
        ...app.querySelectorAll<HTMLElement>(GEOMETRY_SELECTOR),
      ]);
      let changed = false;
      for (const element of observed) {
        if (elements.has(element)) continue;
        observer?.unobserve(element);
        observed.delete(element);
        changed = true;
      }
      for (const element of elements) {
        if (observed.has(element)) continue;
        observer?.observe(element);
        observed.add(element);
        changed = true;
      }
      if (changed) update();
    };
    syncObserved();
    // Lazy terminal mounts and command-picker changes can happen without an
    // App render. Ignore unrelated streaming mutations unless geometry nodes
    // were added or removed; their own resizing is covered by ResizeObserver.
    const mutations =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver((records) => {
            const geometryChanged = records.some((record) =>
              [...record.addedNodes, ...record.removedNodes].some(
                (node) =>
                  node instanceof Element &&
                  (node.matches(GEOMETRY_SELECTOR) ||
                    node.querySelector(GEOMETRY_SELECTOR)),
              ),
            );
            if (geometryChanged) syncObserved();
          });
    mutations?.observe(app, { childList: true, subtree: true });
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      observer?.disconnect();
      mutations?.disconnect();
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      clearCompactLayout(app);
    };
  }, [enabled, appRef]);

  useEffect(() => {
    const app = appRef.current;
    const toggle = toggleRef.current;
    if (!enabled || !app || !toggle) return;
    let animations: Animation[] = [];
    let dragged = false;
    let start: {
      x: number;
      y: number;
      scale: number;
      claimed: boolean;
      baseOffset: number;
      savedOffset: number;
      compact: boolean;
      bounds: MobileControlsStackBounds | null;
    } | null = null;

    const clearDrag = () => {
      app.classList.remove("mobile-controls-dragging");
      app.style.removeProperty("--mobile-controls-drag-x");
      app.style.removeProperty("--mobile-controls-drag-y");
      dragging.current = false;
    };
    const offsetFor = (dy: number) =>
      start?.bounds
        ? clampMobileControlsOffset(start.baseOffset - dy, start.bounds)
        : (start?.baseOffset ?? 0);
    const begin = (x: number, y: number) => {
      dragged = false;
      if (document.documentElement.dataset.layout !== "mobile") return;
      start = {
        x,
        y,
        scale: app.getBoundingClientRect().width / app.offsetWidth,
        claimed: false,
        baseOffset: latest.current.appliedOffset,
        savedOffset: latest.current.placement.offsetY,
        compact: app.hasAttribute(COMPACT_ATTRIBUTE),
        bounds: null,
      };
    };
    const move = (x: number, y: number) => {
      if (!start) return false;
      const dx = x - start.x;
      const dy = y - start.y;
      if (!start.claimed) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_THRESHOLD_PX)
          return false;
        start.claimed = true;
        dragged = true;
        dragging.current = true;
        for (const animation of animations) animation.cancel();
        animations = [];
        // Follow the finger past side-specific obstacles; release re-clamps.
        start.bounds = start.compact
          ? null
          : measureStackBounds(app, start.baseOffset, "left");
        app.classList.add("mobile-controls-dragging");
      }
      // Horizontal follows the finger; vertical stops at the clamp.
      app.style.setProperty(
        "--mobile-controls-drag-x",
        `${dx / start.scale}px`,
      );
      app.style.setProperty(
        "--mobile-controls-drag-y",
        `${start.baseOffset - offsetFor(dy / start.scale)}px`,
      );
      return true;
    };
    const finish = (x: number, y: number) => {
      const current = start;
      start = null;
      if (!current?.claimed) return;
      const side = mobileControlsSideForRelease(x, window.innerWidth);
      const releasedOffset = current.bounds
        ? clampMobileControlsOffset(
            current.baseOffset - (y - current.y) / current.scale,
            current.bounds,
          )
        : current.baseOffset;
      const next: MobileControlsPlacement = {
        side,
        // Save only the user's drag delta. Keyboard/dock lift and a temporary
        // viewport clamp must never become a new persistent resting height.
        offsetY: current.savedOffset + releasedOffset - current.baseOffset,
      };
      const previousAnchor = dragAnchor.current;
      if (releasedOffset !== next.offsetY) {
        dragAnchor.current = {
          offsetY:
            previousAnchor?.savedOffset === current.savedOffset
              ? previousAnchor.offsetY
              : current.savedOffset,
          savedOffset: next.offsetY,
        };
      } else {
        dragAnchor.current = null;
      }
      const row = app.querySelector<HTMLElement>(".mobile-controls-stack");
      const elements = current.compact && row ? [row] : stackElements(app);
      const before = elements.map((element) => element.getBoundingClientRect());
      clearDrag();
      flushSync(() => {
        setAppliedOffset(releasedOffset);
        latest.current.onPlacementChange(next);
      });
      if (reducedMotion()) return;
      const scale = app.getBoundingClientRect().width / app.offsetWidth;
      animations = elements.map((element, index) => {
        const after = element.getBoundingClientRect();
        const from = before[index]!;
        return element.animate(
          [
            {
              translate: `${(from.left - after.left) / scale}px ${(from.top - after.top) / scale}px`,
            },
            { translate: "0px 0px" },
          ],
          { duration: SETTLE_MS, easing: "cubic-bezier(0.2, 0.9, 0.3, 1)" },
        );
      });
    };
    const cancel = () => {
      start = null;
      clearDrag();
      reclamp.current();
    };

    // Preserve the active Composer/Direct editor and an in-progress IME.
    // Cancel mousedown rather than pointerdown so WebKit still delivers taps.
    const mouseDown = (event: MouseEvent) => event.preventDefault();

    const touchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return cancel();
      const touch = event.touches[0]!;
      begin(touch.clientX, touch.clientY);
    };
    const touchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) return cancel();
      const touch = event.touches[0]!;
      if (move(touch.clientX, touch.clientY) && event.cancelable)
        event.preventDefault();
    };
    const touchEnd = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (touch) finish(touch.clientX, touch.clientY);
      else cancel();
      // A drag must not turn into a tap on the toggle.
      if (dragged && event.cancelable) event.preventDefault();
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.pointerType === "touch" || !event.isPrimary || event.button)
        return;
      begin(event.clientX, event.clientY);
      toggle.setPointerCapture(event.pointerId);
    };
    const pointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "touch") move(event.clientX, event.clientY);
    };
    const pointerUp = (event: PointerEvent) => {
      if (event.pointerType !== "touch") finish(event.clientX, event.clientY);
    };
    const pointerCancel = (event: PointerEvent) => {
      if (event.pointerType !== "touch" && start) cancel();
    };
    const clickCapture = (event: MouseEvent) => {
      if (!dragged || event.detail === 0) return;
      dragged = false;
      event.preventDefault();
      event.stopPropagation();
    };

    const row = app.querySelector<HTMLElement>(".mobile-controls-stack");
    const rowMouseDown = (event: MouseEvent) => {
      if (app.hasAttribute(COMPACT_ATTRIBUTE)) event.preventDefault();
    };
    const rowClick = (event: MouseEvent) => {
      if (
        !app.hasAttribute(COMPACT_ATTRIBUTE) ||
        !(event.target instanceof Element)
      )
        return;
      const button = event.target.closest("button");
      if (!button || button.disabled || button === toggle) return;
      // A swipe never produces this click. Navigation may dismiss input; a
      // horizontal pan and the collapse/drag toggle must leave it untouched.
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
    };
    row?.addEventListener("mousedown", rowMouseDown);
    row?.addEventListener("click", rowClick, true);
    toggle.addEventListener("mousedown", mouseDown);
    toggle.addEventListener("touchstart", touchStart, { passive: true });
    toggle.addEventListener("touchmove", touchMove, { passive: false });
    toggle.addEventListener("touchend", touchEnd);
    toggle.addEventListener("touchcancel", cancel);
    toggle.addEventListener("pointerdown", pointerDown);
    toggle.addEventListener("pointermove", pointerMove);
    toggle.addEventListener("pointerup", pointerUp);
    toggle.addEventListener("pointercancel", pointerCancel);
    toggle.addEventListener("lostpointercapture", pointerCancel);
    toggle.addEventListener("click", clickCapture, true);
    return () => {
      for (const animation of animations) animation.cancel();
      // Disposing listeners must not schedule a placement state update.
      clearDrag();
      row?.removeEventListener("mousedown", rowMouseDown);
      row?.removeEventListener("click", rowClick, true);
      toggle.removeEventListener("mousedown", mouseDown);
      toggle.removeEventListener("touchstart", touchStart);
      toggle.removeEventListener("touchmove", touchMove);
      toggle.removeEventListener("touchend", touchEnd);
      toggle.removeEventListener("touchcancel", cancel);
      toggle.removeEventListener("pointerdown", pointerDown);
      toggle.removeEventListener("pointermove", pointerMove);
      toggle.removeEventListener("pointerup", pointerUp);
      toggle.removeEventListener("pointercancel", pointerCancel);
      toggle.removeEventListener("lostpointercapture", pointerCancel);
      toggle.removeEventListener("click", clickCapture, true);
    };
  }, [enabled, appRef, toggleRef]);

  return appliedOffset;
}
